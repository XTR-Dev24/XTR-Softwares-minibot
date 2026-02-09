const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const Pino = require("pino");
const fs = require("fs");
const path = require("path");

const msgRetryCounterCache = new NodeCache();

// Store bot states per session to prevent conflicts
const botStates = new Map();

// Pairing throttles per phone (prevents spam + rate-limit bans)
const pairingLocks = new Map(); // phone -> { inFlight: boolean, lastAt: number }

// -------- Helpers --------
function normalizePhone(phone) {
  // digits only
  return String(phone || "").replace(/\D/g, "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractErrText(err) {
  const parts = [];
  if (err?.message) parts.push(err.message);
  if (err?.output?.payload?.message) parts.push(err.output.payload.message);
  if (err?.data) parts.push(String(err.data));
  return parts.join(" | ").toLowerCase();
}

function isTransientPairingError(err) {
  const msg = extractErrText(err);
  // WhatsApp transient / rate-limit / backend issues often surface like this
  return (
    msg.includes("service currently unavailable") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("rate") ||
    msg.includes("too many") ||
    msg.includes("server") ||
    msg.includes("unavailable") ||
    msg.includes("503") ||
    msg.includes("504")
  );
}

async function requestPairingCodeWithRetry(sock, phoneNumber) {
  // small initial delay helps on some hosts (Render cold start)
  await sleep(400);

  const maxAttempts = 5;
  let backoff = 1200;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sock.requestPairingCode(phoneNumber);
    } catch (err) {
      const transient = isTransientPairingError(err);

      // If it's not transient, fail fast (bad number format, banned, etc.)
      if (!transient || attempt === maxAttempts) {
        throw err;
      }

      // Exponential backoff with jitter
      const jitter = Math.floor(Math.random() * 400);
      await sleep(backoff + jitter);
      backoff *= 1.8;
    }
  }

  // Should never reach here
  throw new Error("Failed to generate pairing code");
}

// -------- Main Handler --------
async function pairHandler(req, res) {
  try {
    const rawPhone = req.query.phone;
    if (!rawPhone) return res.status(400).send("Phone number required");

    const phoneNumber = normalizePhone(rawPhone);

    // Basic sanity check (you can tune this to your market)
    if (phoneNumber.length < 9 || phoneNumber.length > 15) {
      return res.status(400).json({ error: "Invalid phone number format" });
    }

    // Throttle pairing for this phone to avoid WhatsApp rate limiting
    const lock = pairingLocks.get(phoneNumber) || { inFlight: false, lastAt: 0 };
    const now = Date.now();

    if (lock.inFlight) {
      return res.status(429).json({
        error: "Pairing already in progress. Please wait a few seconds and retry."
      });
    }

    // Minimum spacing between requests (prevents spam)
    const MIN_INTERVAL_MS = 12_000;
    if (now - lock.lastAt < MIN_INTERVAL_MS) {
      return res.status(429).json({
        error: "Too many requests. Please wait a bit before requesting a new code."
      });
    }

    lock.inFlight = true;
    lock.lastAt = now;
    pairingLocks.set(phoneNumber, lock);

    const SESSION_DIR = process.env.SESSION_DIR || path.join(process.cwd(), "sessions");
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

    // One folder per phone (keeps multi-user safe)
    const sessionPath = path.join(SESSION_DIR, phoneNumber);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: Pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: "silent" }))
      },
      msgRetryCounterCache
    });

    // Always save creds updates
    sock.ev.on("creds.update", saveCreds);

    // ---------- PAIRING (FIXED) ----------
    if (!state.creds.registered) {
      let done = false;

      const finish = (status, payload) => {
        if (done) return;
        done = true;
        // release lock
        const l = pairingLocks.get(phoneNumber);
        if (l) l.inFlight = false;
        pairingLocks.set(phoneNumber, l || { inFlight: false, lastAt: Date.now() });

        if (!res.headersSent) res.status(status).json(payload);
      };

      // Wait for socket to be ready/open before requesting code
      const timeout = setTimeout(() => {
        finish(504, { error: "Pairing timeout. Try again." });
      }, 25_000);

      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        // If WhatsApp closes before open, return a useful error
        if (connection === "close" && !done) {
          const msg = extractErrText(lastDisconnect?.error);
          clearTimeout(timeout);

          // release lock
          const l = pairingLocks.get(phoneNumber);
          if (l) l.inFlight = false;
          pairingLocks.set(phoneNumber, l || { inFlight: false, lastAt: Date.now() });

          if (!res.headersSent) {
            return res.status(500).json({
              error: "Connection closed before pairing code could be generated",
              details: msg || "unknown"
            });
          }
          return;
        }

        if (connection === "open" && !done) {
          try {
            // Retry/backoff to fix "service currently unavailable"
            const code = await requestPairingCodeWithRetry(sock, phoneNumber);
            clearTimeout(timeout);
            finish(200, { code });
          } catch (err) {
            clearTimeout(timeout);
            const msg = extractErrText(err);
            finish(500, {
              error: "Failed to generate pairing code",
              details: msg || "unknown"
            });
          }
        }
      });

      return;
    }

    // release lock if already registered
    const l = pairingLocks.get(phoneNumber);
    if (l) l.inFlight = false;
    pairingLocks.set(phoneNumber, l || { inFlight: false, lastAt: Date.now() });

    // ---------- BOT STATE ----------
    if (!botStates.has(phoneNumber)) {
      botStates.set(phoneNumber, {
        autoView: false,
        autoReact: false,
        antiDelete: true,
        reactEmoji: "❤️",
        messageCache: new Map()
      });
    }
    const botState = botStates.get(phoneNumber);

    // ---------- MINIBOT LISTENERS ----------
    // Only attach once per socket instance
    if (!sock.__minibotStarted) {
      sock.__minibotStarted = true;

      // Handle incoming messages + commands
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
          if (type !== "notify") return;
          const msg = messages?.[0];
          if (!msg?.message) return;

          const jid = msg.key.remoteJid;
          const messageId = msg.key.id;

          // Cache messages for anti-delete
          if (botState.antiDelete && messageId) {
            botState.messageCache.set(messageId, msg);
            setTimeout(() => botState.messageCache.delete(messageId), 5 * 60 * 1000);
          }

          // Auto-view status
          if (botState.autoView && jid === "status@broadcast") {
            await sock.readMessages([msg.key]);
            return;
          }

          // Skip group messages (keeps your "core behavior" intact)
          if (jid.endsWith("@g.us")) return;

          // Extract message text
          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            "";

          // Auto-react (skip commands + status)
          if (botState.autoReact && jid !== "status@broadcast" && !text.startsWith(".")) {
            try {
              await sock.sendMessage(jid, {
                react: { key: msg.key, text: botState.reactEmoji }
              });
            } catch {}
          }

          if (!text.startsWith(".")) return;

          const parts = text.slice(1).trim().split(/\s+/);
          const cmd = (parts.shift() || "").toLowerCase();
          const args = parts;

          let reply = null;

          switch (cmd) {
            case "ping":
              reply = "pong ✅";
              break;

            case "help":
            case "menu":
              reply =
                `Available commands:\n` +
                `.ping\n` +
                `.autoview on|off\n` +
                `.autoreact on|off\n` +
                `.reactemoji 😄\n` +
                `.antidelete on|off`;
              break;

            case "autoview": {
              const v = (args[0] || "").toLowerCase();
              if (v === "on" || v === "off") {
                botState.autoView = v === "on";
                reply = `Auto View Status: ${botState.autoView ? "ON" : "OFF"}`;
              } else {
                reply = `Auto View Status is ${botState.autoView ? "ON" : "OFF"}.\nUse: .autoview on|off`;
              }
              break;
            }

            case "autoreact": {
              const v = (args[0] || "").toLowerCase();
              if (v === "on" || v === "off") {
                botState.autoReact = v === "on";
                reply = `Auto React: ${botState.autoReact ? "ON" : "OFF"}`;
              } else {
                reply = `Auto React is ${botState.autoReact ? "ON" : "OFF"}.\nUse: .autoreact on|off`;
              }
              break;
            }

            case "reactemoji":
              if (args[0]) {
                botState.reactEmoji = args[0];
                reply = `Reaction emoji set to ${botState.reactEmoji}`;
              } else {
                reply = `Current reaction emoji: ${botState.reactEmoji}\nUse: .reactemoji 😄`;
              }
              break;

            case "antidelete": {
              const v = (args[0] || "").toLowerCase();
              if (v === "on" || v === "off") {
                botState.antiDelete = v === "on";
                reply = `Anti Delete: ${botState.antiDelete ? "ON" : "OFF"}`;
              } else {
                reply = `Anti Delete is ${botState.antiDelete ? "ON" : "OFF"}.\nUse: .antidelete on|off`;
              }
              break;
            }
          }

          if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
          }
        } catch (error) {
          console.error("Message processing error:", error);
        }
      });

      // Anti-delete recovery (best-effort; works for many revoke events)
      sock.ev.on("messages.update", async (updates) => {
        try {
          for (const update of updates || []) {
            // Many setups see revoke events differently; status==3 is one common path
            if (update?.update?.status === 3) {
              const messageId = update.key?.id;
              const cached = messageId ? botState.messageCache.get(messageId) : null;
              if (!cached) continue;

              const messageText =
                cached.message.conversation ||
                cached.message.extendedTextMessage?.text ||
                cached.message.imageMessage?.caption ||
                "[Media message]";

              await sock.sendMessage(update.key.remoteJid, {
                text: `🛑 Deleted message recovered:\n\n${messageText}`
              });

              botState.messageCache.delete(messageId);
            }
          }
        } catch (error) {
          console.error("Anti-delete error:", error);
        }
      });

      // Connection close handling (don’t recurse HTTP handler; just cleanup if logout)
      sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            botStates.delete(phoneNumber);
            console.log(`Session logged out: ${phoneNumber}`);
          }
        }
      });
    }

    return res.json({
      status: "Bot connected & running",
      phone: phoneNumber,
      registered: state.creds.registered
    });
  } catch (error) {
    console.error("Pair handler error:", error);

    // Ensure lock released on handler crash
    const phoneNumber = normalizePhone(req?.query?.phone);
    if (phoneNumber) {
      const l = pairingLocks.get(phoneNumber);
      if (l) l.inFlight = false;
      pairingLocks.set(phoneNumber, l || { inFlight: false, lastAt: Date.now() });
    }

    res.status(500).json({
      error: "Internal server error",
      details: error.message
    });
  }
}

module.exports = pairHandler;
