import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} from "@whiskeysockets/baileys";
import NodeCache from "node-cache";
import Pino from "pino";
import fs from "fs";
import path from "path";

const msgRetryCounterCache = new NodeCache();

// Store bot states per session to prevent conflicts
const botStates = new Map();

export default async function pairHandler(req, res) {
  try {
    const phoneNumber = req.query.phone;
    if (!phoneNumber) return res.status(400).send("Phone number required");

    const SESSION_DIR = process.env.SESSION_DIR || 
                       path.join(process.cwd(), "sessions");

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
        keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: "silent" }))
      },
      msgRetryCounterCache
    });

    // Send pairing code if not registered
    if (!state.creds.registered) {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        return res.json({ code });
      } catch (error) {
        console.error("Pairing error:", error);
        return res.status(500).json({ error: "Failed to get pairing code" });
      }
    }

    // Initialize bot state for this session if not exists
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

    // Initialize event listeners only once per socket
    if (!sock.__minibotStarted) {
      sock.__minibotStarted = true;

      // Handle credentials update
      sock.ev.on("creds.update", saveCreds);

      // Handle incoming messages
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
          if (type !== "notify") return;
          const msg = messages[0];
          if (!msg.message) return;

          const jid = msg.key.remoteJid;
          const messageId = msg.key.id;

          // Cache messages for anti-delete
          if (botState.antiDelete && messageId) {
            botState.messageCache.set(messageId, msg);
            // Auto-clean cache after 5 minutes
            setTimeout(() => {
              botState.messageCache.delete(messageId);
            }, 5 * 60 * 1000);
          }

          // Auto-view status
          if (botState.autoView && jid === "status@broadcast") {
            await sock.readMessages([msg.key]);
            return;
          }

          // Skip group messages except for status and anti-delete
          if (jid.endsWith("@g.us")) return;

          // Extract message text
          const text = msg.message.conversation ||
                      msg.message.extendedTextMessage?.text ||
                      msg.message.imageMessage?.caption ||
                      "";

          if (!text.startsWith(".")) return;

          const cmd = text.slice(1).toLowerCase().trim();
          const args = text.slice(1).split(" ").slice(1);
          const mainCmd = args.length > 0 ? cmd.split(" ")[0] : cmd;

          let reply = null;

          switch (mainCmd) {
            case "ping":
              reply = "pong ✅";
              break;
            case "help":
              reply = `Available commands:\n` +
                     `.ping - Test if bot is working\n` +
                     `.autoview on|off - Toggle auto-view status\n` +
                     `.autoreact on|off - Toggle auto-reaction\n` +
                     `.reactemoji 😄 - Set reaction emoji\n` +
                     `.antidelete on|off - Toggle anti-delete feature`;
              break;
            case "autoview":
              const viewState = args[0]?.toLowerCase();
              if (viewState === "on" || viewState === "off") {
                botState.autoView = viewState === "on";
                reply = `Auto View Status: ${botState.autoView ? "ON" : "OFF"}`;
              } else {
                reply = `Current Auto View Status: ${botState.autoView ? "ON" : "OFF"}\nUse: .autoview on|off`;
              }
              break;
            case "autoreact":
              const reactState = args[0]?.toLowerCase();
              if (reactState === "on" || reactState === "off") {
                botState.autoReact = reactState === "on";
                reply = `Auto React: ${botState.autoReact ? "ON" : "OFF"}`;
              } else {
                reply = `Current Auto React: ${botState.autoReact ? "ON" : "OFF"}\nUse: .autoreact on|off`;
              }
              break;
            case "reactemoji":
              if (args[0]) {
                botState.reactEmoji = args[0];
                reply = `Reaction emoji set to ${botState.reactEmoji}`;
              } else {
                reply = `Current reaction emoji: ${botState.reactEmoji}\nUse: .reactemoji 😄`;
              }
              break;
            case "antidelete":
              const deleteState = args[0]?.toLowerCase();
              if (deleteState === "on" || deleteState === "off") {
                botState.antiDelete = deleteState === "on";
                reply = `Anti Delete: ${botState.antiDelete ? "ON" : "OFF"}`;
              } else {
                reply = `Current Anti Delete: ${botState.antiDelete ? "ON" : "OFF"}\nUse: .antidelete on|off`;
              }
              break;
          }

          if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
          }
        } catch (error) {
          console.error("Message processing error:", error);
        }
      });

      // Auto react to messages
      sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
          const msg = messages[0];
          if (!msg?.message || !botState.autoReact) return;
          
          const jid = msg.key.remoteJid;
          
          // Don't auto-react to group messages or status
          if (jid.endsWith("@g.us") || jid === "status@broadcast") return;
          
          // Don't react to bot's own messages or commands
          const text = msg.message.conversation || "";
          if (text.startsWith(".")) return;

          await sock.sendMessage(jid, {
            react: { 
              key: msg.key, 
              text: botState.reactEmoji 
            }
          });
        } catch (error) {
          console.error("Auto-react error:", error);
        }
      });

      // Anti-delete recovery
      sock.ev.on("messages.update", async (updates) => {
        try {
          for (const update of updates) {
            if (update.update?.status === 3) { // Message deleted
              const messageId = update.key.id;
              const cached = botState.messageCache.get(messageId);
              
              if (cached) {
                const messageText = cached.message.conversation ||
                                  cached.message.extendedTextMessage?.text ||
                                  cached.message.imageMessage?.caption ||
                                  "[Media message]";
                
                await sock.sendMessage(update.key.remoteJid, {
                  text: `🛑 Deleted message recovered:\n\n${messageText}`
                });
                
                // Remove from cache after recovery
                botState.messageCache.delete(messageId);
              }
            }
          }
        } catch (error) {
          console.error("Anti-delete error:", error);
        }
      });

      // Handle connection updates
      sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 
                                DisconnectReason.loggedOut;
          
          if (shouldReconnect) {
            console.log(`Reconnecting session: ${phoneNumber}`);
            // Clean up old state
            sock.__minibotStarted = false;
            // Re-initialize after delay
            setTimeout(() => {
              pairHandler(req, res);
            }, 5000);
          } else {
            // Clean up on logout
            botStates.delete(phoneNumber);
            console.log(`Session logged out: ${phoneNumber}`);
          }
        }
      });
    }

    res.json({ 
      status: "Bot connected & running",
      phone: phoneNumber,
      registered: state.creds.registered
    });
  } catch (error) {
    console.error("Pair handler error:", error);
    res.status(500).json({ 
      error: "Internal server error", 
      details: error.message 
    });
  }
}
