const { 
    giftedId,
    removeFile
} = require('../gift');
const QRCode = require('qrcode');
const express = require('express');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
let router = express.Router();
const pino = require("pino");
const NodeCache = require("node-cache");
const msgRetryCounterCache = new NodeCache();
const { sendButtons } = require('gifted-btns');
const {
    default: giftedConnect,
    useMultiFileAuthState,
    Browsers,
    delay,
    downloadContentFromMessage, 
    generateWAMessageFromContent, 
    normalizeMessageContent,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const sessionDir = process.env.SESSION_DIR
    ? path.resolve(process.env.SESSION_DIR)
    : path.join(__dirname, "session");
// Ensure session directory exists (important for Render/containers)
try { fs.mkdirSync(sessionDir, { recursive: true }); } catch (e) {}


router.get('/', async (req, res) => {
    const id = giftedId();
    let responseSent = false;
    let sessionCleanedUp = false;

    async function cleanUpSession() {
        if (!sessionCleanedUp) {
            await removeFile(path.join(sessionDir, id));
            sessionCleanedUp = true;
        }
    }

    async function GIFTED_QR_CODE() {
        const { version } = await fetchLatestBaileysVersion();
        console.log(version);
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, id));
        try {
            let Gifted = giftedConnect({
                version,
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS("Desktop"),
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                msgRetryCounterCache
            });

            Gifted.ev.on('creds.update', saveCreds);
            Gifted.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect, qr } = s;
                
                if (qr && !responseSent) {
                    const qrImage = await QRCode.toDataURL(qr);
                    if (!res.headersSent) {
                        res.send(`
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Advanced QR Scanner</title>
                        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
                        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Orbitron:wght@400;500;600;700&display=swap" rel="stylesheet">
                        <style>
                            :root {
                                --primary-blue: #0066ff;
                                --accent-cyan: #00d4ff;
                                --success-green: #00c851;
                                --warning-orange: #ff8800;
                                --error-red: #ff4444;
                                --dark-bg: #0a0a1a;
                                --card-bg: rgba(10, 20, 40, 0.9);
                                --border-glow: rgba(0, 102, 255, 0.3);
                                --text-primary: #ffffff;
                                --text-secondary: #a0a0a0;
                                --neon-purple: #9d4edd;
                                --electric-blue: #4cc9f0;
                            }
                            
                            * {
                                margin: 0;
                                padding: 0;
                                box-sizing: border-box;
                            }
                            
                            body {
                                font-family: 'Inter', sans-serif;
                                background: linear-gradient(135deg, #0a0a1a 0%, #1a0a2e 50%, #16213e 100%);
                                min-height: 100vh;
                                color: var(--text-primary);
                                position: relative;
                                overflow-x: hidden;
                                padding: 20px 0;
                            }
                            
                            /* Enhanced Animated Background */
                            .animated-bg {
                                position: fixed;
                                top: 0;
                                left: 0;
                                width: 100%;
                                height: 100%;
                                z-index: -1;
                                background: 
                                    radial-gradient(circle at 15% 85%, rgba(0, 102, 255, 0.15) 0%, transparent 60%),
                                    radial-gradient(circle at 85% 15%, rgba(157, 78, 221, 0.12) 0%, transparent 60%),
                                    radial-gradient(circle at 50% 50%, rgba(76, 201, 240, 0.08) 0%, transparent 70%);
                                animation: bgPulse 12s ease-in-out infinite;
                            }

                            @keyframes bgPulse {
                                0%, 100% { opacity: 0.8; transform: scale(1) rotate(0deg); }
                                50% { opacity: 1; transform: scale(1.1) rotate(2deg); }
                            }

                            /* Enhanced Floating Orbs */
                            .floating-orb {
                                position: fixed;
                                border-radius: 50%;
                                background: linear-gradient(135deg, rgba(0, 102, 255, 0.2), rgba(76, 201, 240, 0.1));
                                animation: floatOrb 20s ease-in-out infinite;
                                backdrop-filter: blur(15px);
                                border: 1px solid rgba(255, 255, 255, 0.1);
                            }

                            .orb1 {
                                width: 250px;
                                height: 250px;
                                top: 5%;
                                left: 5%;
                                animation-delay: 0s;
                                background: linear-gradient(135deg, rgba(157, 78, 221, 0.25), rgba(0, 102, 255, 0.15));
                            }

                            .orb2 {
                                width: 180px;
                                height: 180px;
                                top: 65%;
                                right: 10%;
                                animation-delay: -7s;
                                background: linear-gradient(135deg, rgba(76, 201, 240, 0.2), rgba(0, 212, 255, 0.1));
                            }

                            .orb3 {
                                width: 120px;
                                height: 120px;
                                bottom: 15%;
                                left: 15%;
                                animation-delay: -14s;
                                background: linear-gradient(135deg, rgba(0, 200, 81, 0.15), rgba(0, 102, 255, 0.1));
                            }

                            @keyframes floatOrb {
                                0%, 100% { transform: translate(0, 0) scale(1) rotate(0deg); }
                                25% { transform: translate(40px, -40px) scale(1.15) rotate(90deg); }
                                50% { transform: translate(-30px, 30px) scale(0.85) rotate(180deg); }
                                75% { transform: translate(30px, 40px) scale(1.05) rotate(270deg); }
                            }

                            /* Main Container - Scrollable like pair HTML */
                            .page-container {
                                display: flex;
                                justify-content: center;
                                align-items: flex-start;
                                min-height: 100vh;
                                padding: 40px 20px;
                                position: relative;
                                z-index: 10;
                            }

                            .main-container {
                                width: 100%;
                                max-width: 550px;
                                padding: 45px;
                                background: var(--card-bg);
                                border-radius: 25px;
                                border: 2px solid rgba(76, 201, 240, 0.2);
                                box-shadow: 
                                    0 25px 50px rgba(0, 0, 0, 0.4),
                                    0 0 40px rgba(76, 201, 240, 0.15),
                                    inset 0 1px 0 rgba(255, 255, 255, 0.1);
                                backdrop-filter: blur(25px);
                                position: relative;
                                margin: 0 auto;
                                text-align: center;
                            }

                            .main-container::before {
                                content: '';
                                position: absolute;
                                top: 0;
                                left: 0;
                                right: 0;
                                bottom: 0;
                                border-radius: 25px;
                                padding: 2px;
                                background: linear-gradient(135deg, var(--electric-blue), var(--neon-purple), var(--primary-blue));
                                mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                                mask-composite: exclude;
                                z-index: -1;
                                animation: borderGlow 3s ease-in-out infinite;
                            }

                            @keyframes borderGlow {
                                0%, 100% { opacity: 0.6; }
                                50% { opacity: 1; }
                            }
                            
                            .header {
                                margin-bottom: 40px;
                                color: white;
                            }
                            
                            .title {
                                font-family: 'Orbitron', monospace;
                                font-size: 2.8rem;
                                font-weight: 700;
                                background: linear-gradient(135deg, var(--electric-blue), var(--neon-purple), var(--primary-blue));
                                -webkit-background-clip: text;
                                -webkit-text-fill-color: transparent;
                                background-clip: text;
                                margin-bottom: 15px;
                                letter-spacing: 2px;
                                text-shadow: 0 0 30px rgba(76, 201, 240, 0.5);
                            }
                            
                            .subtitle {
                                font-size: 1.3rem;
                                color: var(--electric-blue);
                                margin-bottom: 8px;
                                font-weight: 600;
                                text-shadow: 0 0 15px rgba(76, 201, 240, 0.3);
                            }
                            
                            .instruction {
                                font-size: 1.05rem;
                                color: var(--text-secondary);
                                margin-bottom: 35px;
                                line-height: 1.5;
                            }
                            
                            .qr-container {
                                background: linear-gradient(135deg, rgba(0, 0, 0, 0.9), rgba(10, 20, 40, 0.8));
                                padding: 35px;
                                border-radius: 25px;
                                border: 3px solid var(--electric-blue);
                                box-shadow: 
                                    0 25px 50px rgba(0, 0, 0, 0.4),
                                    0 0 40px rgba(76, 201, 240, 0.3);
                                backdrop-filter: blur(25px);
                                animation: qrGlow 3s ease-in-out infinite;
                                position: relative;
                                overflow: hidden;
                                margin: 30px 0;
                            }

                            .qr-container::before {
                                content: '';
                                position: absolute;
                                top: 0;
                                left: 0;
                                right: 0;
                                bottom: 0;
                                background: linear-gradient(45deg, transparent 30%, rgba(76, 201, 240, 0.1) 50%, transparent 70%);
                                animation: codeShimmer 2s ease-in-out infinite;
                            }

                            @keyframes codeShimmer {
                                0% { transform: translateX(-100%); }
                                100% { transform: translateX(100%); }
                            }
                            
                            @keyframes qrGlow {
                                0%, 100% { 
                                    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4), 0 0 30px rgba(76, 201, 240, 0.3);
                                }
                                50% { 
                                    box-shadow: 0 30px 60px rgba(0, 0, 0, 0.5), 0 0 50px rgba(76, 201, 240, 0.5);
                                }
                            }
                            
                            .qr-image-wrapper {
                                position: relative;
                                display: inline-block;
                            }
                            
                            .qr-image {
                                width: 320px;
                                height: 320px;
                                border-radius: 20px;
                                transition: all 0.4s ease;
                                border: 3px solid rgba(255, 255, 255, 0.1);
                                position: relative;
                                z-index: 1;
                            }
                            
                            .qr-image:hover {
                                transform: scale(1.05);
                                border-color: var(--electric-blue);
                                box-shadow: 0 0 30px rgba(76, 201, 240, 0.6);
                            }

                            .scan-animation {
                                position: absolute;
                                top: 0;
                                left: 0;
                                right: 0;
                                bottom: 0;
                                border-radius: 20px;
                                background: linear-gradient(
                                    45deg,
                                    transparent 30%,
                                    rgba(76, 201, 240, 0.2) 50%,
                                    transparent 70%
                                );
                                animation: scanLine 2s ease-in-out infinite;
                            }

                            @keyframes scanLine {
                                0% { transform: translateX(-100%); }
                                100% { transform: translateX(100%); }
                            }
                            
                            .footer {
                                margin-top: 40px;
                                color: white;
                                text-align: center;
                            }
                            
                            .steps {
                                display: flex;
                                flex-direction: column;
                                gap: 15px;
                                font-size: 1rem;
                                color: var(--text-secondary);
                                max-width: 100%;
                                margin: 0 auto;
                            }
                            
                            .step {
                                display: flex;
                                align-items: center;
                                gap: 15px;
                                padding: 15px 20px;
                                background: rgba(76, 201, 240, 0.1);
                                border-radius: 15px;
                                border-left: 4px solid var(--electric-blue);
                                backdrop-filter: blur(10px);
                                transition: all 0.3s ease;
                                text-align: left;
                            }

                            .step:hover {
                                background: rgba(76, 201, 240, 0.15);
                                transform: translateX(5px);
                            }
                            
                            .step-icon {
                                color: var(--electric-blue);
                                width: 25px;
                                font-size: 1.2rem;
                                text-align: center;
                                flex-shrink: 0;
                            }
                            
                            .creator {
                                margin-top: 30px;
                                font-size: 1rem;
                                color: var(--electric-blue);
                                font-weight: 600;
                                text-shadow: 0 0 10px rgba(76, 201, 240, 0.3);
                            }
                            
                            .refresh-btn {
                                position: absolute;
                                top: 30px;
                                right: 30px;
                                background: linear-gradient(135deg, var(--electric-blue), var(--neon-purple));
                                border: none;
                                padding: 15px;
                                border-radius: 50%;
                                color: white;
                                cursor: pointer;
                                font-size: 1.3rem;
                                transition: all 0.4s ease;
                                box-shadow: 0 5px 20px rgba(76, 201, 240, 0.3);
                                backdrop-filter: blur(10px);
                                z-index: 1000;
                            }
                            
                            .refresh-btn:hover {
                                transform: rotate(180deg) scale(1.15);
                                box-shadow: 0 8px 25px rgba(76, 201, 240, 0.5);
                            }
                            
                            .back-btn {
                                position: absolute;
                                top: 30px;
                                left: 30px;
                                background: linear-gradient(135deg, var(--neon-purple), var(--electric-blue));
                                border: none;
                                padding: 15px 25px;
                                border-radius: 25px;
                                color: white;
                                cursor: pointer;
                                font-size: 1rem;
                                font-weight: 600;
                                transition: all 0.4s ease;
                                text-decoration: none;
                                display: flex;
                                align-items: center;
                                gap: 10px;
                                backdrop-filter: blur(10px);
                                text-transform: uppercase;
                                letter-spacing: 0.5px;
                                z-index: 1000;
                            }
                            
                            .back-btn:hover {
                                transform: translateY(-3px);
                                box-shadow: 0 10px 25px rgba(157, 78, 221, 0.4);
                            }

                            /* Desktop Responsive */
                            @media (min-width: 768px) {
                                .page-container {
                                    padding: 50px 40px;
                                }
                                
                                .main-container {
                                    max-width: 600px;
                                    padding: 50px;
                                }

                                .qr-image {
                                    width: 350px;
                                    height: 350px;
                                }

                                .qr-container {
                                    padding: 40px;
                                    margin: 40px 0;
                                }
                            }

                            /* Mobile Responsive */
                            @media (max-width: 767px) {
                                .page-container {
                                    padding: 20px 10px;
                                }
                                
                                .main-container {
                                    margin: 0;
                                    padding: 30px 25px;
                                    max-width: 95%;
                                }
                                
                                .title {
                                    font-size: 2.2rem;
                                }
                                
                                .qr-image {
                                    width: 280px;
                                    height: 280px;
                                }
                                
                                .qr-container {
                                    padding: 25px;
                                    margin: 25px 0;
                                }
                                
                                .refresh-btn, .back-btn {
                                    top: 20px;
                                }
                                
                                .refresh-btn {
                                    right: 20px;
                                    padding: 12px;
                                    font-size: 1.1rem;
                                }
                                
                                .back-btn {
                                    left: 20px;
                                    padding: 12px 20px;
                                    font-size: 0.9rem;
                                }

                                .steps {
                                    font-size: 0.9rem;
                                }

                                .step {
                                    padding: 12px 15px;
                                }
                            }

                            /* Extra small screens */
                            @media (max-width: 400px) {
                                .qr-image {
                                    width: 250px;
                                    height: 250px;
                                }
                                
                                .main-container {
                                    padding: 25px 20px;
                                }

                                .qr-container {
                                    padding: 20px;
                                }
                            }
                        </style>
                    </head>
                    <body>
                        <!-- Enhanced Animated Background -->
                        <div class="animated-bg"></div>
                        <div class="floating-orb orb1"></div>
                        <div class="floating-orb orb2"></div>
                        <div class="floating-orb orb3"></div>
                        
                        <button class="refresh-btn" onclick="window.location.reload()">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                        
                        <a href="/" class="back-btn">
                            <i class="fas fa-arrow-left"></i>
                            <span>Back</span>
                        </a>
                        
                        <div class="page-container">
                            <div class="main-container">
                                <div class="header">
                                    <h1 class="title">CarlTech</h1>
                                    <h2 class="subtitle">QR Code Scanner</h2>
                                    <p class="instruction">Scan the QR code below with your WhatsApp to connect</p>
                                </div>
                                
                                <div class="qr-container">
                                    <div class="qr-image-wrapper">
                                        <img src="${qrImage}" alt="QR Code" class="qr-image">
                                        <div class="scan-animation"></div>
                                    </div>
                                </div>
                                
                                <div class="footer">
                                    <div class="steps">
                                        <div class="step">
                                            <div class="step-icon">
                                                <i class="fas fa-mobile-alt"></i>
                                            </div>
                                            <span>Open WhatsApp on your phone</span>
                                        </div>
                                        <div class="step">
                                            <div class="step-icon">
                                                <i class="fas fa-ellipsis-v"></i>
                                            </div>
                                            <span>Tap on the 3-dot menu</span>
                                        </div>
                                        <div class="step">
                                            <div class="step-icon">
                                                <i class="fas fa-qrcode"></i>
                                            </div>
                                            <span>Select "Linked Devices"</span>
                                        </div>
                                        <div class="step">
                                            <div class="step-icon">
                                                <i class="fas fa-camera"></i>
                                            </div>
                                            <span>Scan this QR code</span>
                                        </div>
                                    </div>
                                    
                                    <div class="creator">
                                        Powered by carl and ibrahim adams
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <script>
                            // Auto refresh QR every 60 seconds
                            setTimeout(() => {
                                window.location.reload();
                            }, 60000);
                            
                            // Add some interactive effects
                            document.addEventListener('DOMContentLoaded', function() {
                                const qrImage = document.querySelector('.qr-image');
                                const container = document.querySelector('.qr-container');
                                
                                // Add click to enlarge functionality
                                qrImage.addEventListener('click', function() {
                                    if (this.style.transform === 'scale(1.2)') {
                                        this.style.transform = 'scale(1)';
                                        this.style.zIndex = '1';
                                        container.style.zIndex = '10';
                                    } else {
                                        this.style.transform = 'scale(1.2)';
                                        this.style.zIndex = '1000';
                                        container.style.zIndex = '1001';
                                    }
                                });
                            });
                        </script>
                    </body>
                    </html>
                        `);
                        responseSent = true;
                    }
                }

                if (connection === "open") {
                    // Removed the group invite code
                    await delay(5000); // Reduced delay since we're not joining groups

                    let sessionData = null;
                    let attempts = 0;
                    const maxAttempts = 10;
                    
                    while (attempts < maxAttempts && !sessionData) {
                        try {
                            const credsPath = path.join(sessionDir, id, "creds.json");
                            if (fs.existsSync(credsPath)) {
                                const data = fs.readFileSync(credsPath);
                                if (data && data.length > 100) {
                                    sessionData = data;
                                    break;
                                }
                            }
                            await delay(2000);
                            attempts++;
                        } catch (readError) {
                            console.error("Read error:", readError);
                            await delay(2000);
                            attempts++;
                        }
                    }

                    if (!sessionData) {
                        await cleanUpSession();
                        return;
                    }

                    try {
                        let compressedData = zlib.gzipSync(sessionData);
                        let b64data = compressedData.toString('base64');
                        const Sess = await sendButtons(Gifted, Gifted.user.id, {
            title: '',
            text: 'Buddy~' + b64data,
            footer: `> *Made By XTR Developers*`,
            buttons: [
                { 
                    name: 'cta_copy', 
                    buttonParamsJson: JSON.stringify({ 
                        display_text: 'Copy Session', 
                        copy_code: 'Buddy~' + b64data 
                    }) 
                },
                {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: 'Visit Bot Repo',
                        url: 'https://github.com/carl24tech/Buddy-XTR'
                    })
                },
                {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: 'Join WaChannel',
                        url: 'https://whatsapp.com/channel/002b3hlgX5kg7G0nFggl0Y'
                    })
                }
            ]
        });

                        await delay(2000);
                        await Gifted.ws.close();
                    } catch (sendError) {
                        console.error("Error sending session:", sendError);
                    } finally {
                        await cleanUpSession();
                    }
                    
                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode != 401) {
                    await delay(10000);
                    GIFTED_QR_CODE();
                }
            });
        } catch (err) {
            console.error("Main error:", err);
            if (!responseSent) {
                res.status(500).json({ code: "QR Service is Currently Unavailable" });
                responseSent = true;
            }
            await cleanUpSession();
        }
    }

    try {
        await GIFTED_QR_CODE();
    } catch (finalError) {
        console.error("Final error:", finalError);
        await cleanUpSession();
        if (!responseSent) {
            res.status(500).json({ code: "Service Error" });
        }
    }
});

module.exports = router;
