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
const botStates = new Map();

/* ---------------- HELPERS ---------------- */
function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

/* ---------------- MAIN HANDLER ---------------- */
async function pairHandler(req, res) {
  try {
    const phoneRaw = req.query.phone;
    if (!phoneRaw) return res.status(400).send("Phone number required");

    const phoneNumber = normalizePhone(phoneRaw);

    const SESSION_DIR =
      process.env.SESSION_DIR || path.join(process.cwd(), "sessions");

    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const sessionPath = path.join(SESSION_DIR, phoneNumber);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: Pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          Pino({ level: "silent" })
        )
      },
      msgRetryCounterCache
    });

    /* ---------------- PAIRING CODE (FIXED) ---------------- */
    if (!state.creds.registered) {
      let codeSent = false;

      sock.ev.on("connection.update", async ({ connection }) => {
        if (connection === "open" && !codeSent) {
          codeSent = true;
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            if (!res.headersSent) {
              return res.json({ code });
            }
          } catch (err) {
            console.error("Pairing code error:", err);
            if (!res.headersSent) {
              return res
                .status(500)
                .json({ error: "Failed to generate pairing code" });
            }
          }
        }
      });

      // Safety timeout
      setTimeout(() => {
        if (!codeSent && !res.headersSent) {
          res
            .status(504)
            .json({ error: "Pairing timeout. Try again." });
        }
      }, 15000);

      return;
    }

    /* ---------------- BOT STATE ---------------- */
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

    /* ---------------- MINIBOT LISTENERS ---------------- */
    if (!sock.__minibotStarted) {
      sock.__minibotStarted = true;

      sock.ev.on("creds.update", saveCreds);

      /* ---- MESSAGE HANDLER ---- */
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const msg = messages[0];
        if (!msg?.message) return;

        const jid = msg.key.remoteJid;
        const msgId = msg.key.id;

        // Cache for anti-delete
        if (botState.antiDelete && msgId) {
          botState.messageCache.set(msgId, msg);
          setTimeout(
            () => botState.messageCache.delete(msgId),
            5 * 60 * 1000
          );
        }

        // Auto view status
        if (botState.autoView && jid === "status@broadcast") {
          await sock.readMessages([msg.key]);
          return;
        }

        if (jid.endsWith("@g.us")) return;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          "";

        if (!text.startsWith(".")) return;

        const parts = text.slice(1).trim().split(/\s+/);
        const cmd = parts.shift().toLowerCase();
        const args = parts;

        let reply = null;

        switch (cmd) {
          case "ping":
            reply = "pong ✅";
            break;

          case "help":
            reply =
              `.ping\n` +
              `.autoview on|off\n` +
              `.autoreact on|off\n` +
              `.reactemoji 😄\n` +
              `.antidelete on|off`;
            break;

          case "autoview":
            botState.autoView = args[0] === "on";
            reply = `Auto View Status: ${
              botState.autoView ? "ON" : "OFF"
            }`;
            break;

          case "autoreact":
            botState.autoReact = args[0] === "on";
            reply = `Auto React: ${
              botState.autoReact ? "ON" : "OFF"
            }`;
            break;

          case "reactemoji":
            if (args[0]) {
              botState.reactEmoji = args[0];
              reply = `Reaction emoji set to ${botState.reactEmoji}`;
            }
            break;

          case "antidelete":
            botState.antiDelete = args[0] === "on";
            reply = `Anti Delete: ${
              botState.antiDelete ? "ON" : "OFF"
            }`;
            break;
        }

        if (reply) {
          await sock.sendMessage(
            jid,
            { text: reply },
            { quoted: msg }
          );
        }
      });

      /* ---- AUTO REACT ---- */
      sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message || !botState.autoReact) return;

        const jid = msg.key.remoteJid;
        if (jid.endsWith("@g.us") || jid === "status@broadcast") return;

        const text = msg.message.conversation || "";
        if (text.startsWith(".")) return;

        await sock.sendMessage(jid, {
          react: { key: msg.key, text: botState.reactEmoji }
        });
      });

      /* ---- ANTI DELETE ---- */
      sock.ev.on("messages.update", async updates => {
        for (const u of updates) {
          if (u.update?.status === 3) {
            const cached = botState.messageCache.get(u.key.id);
            if (!cached) continue;

            const recovered =
              cached.message.conversation ||
              cached.message.extendedTextMessage?.text ||
              cached.message.imageMessage?.caption ||
              "[Media message]";

            await sock.sendMessage(u.key.remoteJid, {
              text: `🛑 Deleted message recovered:\n\n${recovered}`
            });

            botState.messageCache.delete(u.key.id);
          }
        }
      });

      /* ---- CONNECTION ---- */
      sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (
          connection === "close" &&
          lastDisconnect?.error?.output?.statusCode ===
            DisconnectReason.loggedOut
        ) {
          botStates.delete(phoneNumber);
        }
      });
    }

    res.json({
      status: "Bot connected & running",
      phone: phoneNumber,
      registered: true
    });
  } catch (err) {
    console.error("Pair handler error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = pairHandler;
