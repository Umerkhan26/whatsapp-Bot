/**
 * WhatsApp Bot using Baileys - RELIABLE message receiving
 * Baileys uses WebSocket directly (no Puppeteer/Chrome) - much more reliable than venom-bot
 */
require('dotenv').config();
const express = require('express');
const fs = require('fs-extra');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const authFolder = './baileys_auth';
const qrFolder = './qrcodes';

  fs.ensureDirSync(qrFolder);
  fs.ensureDirSync('./receipts');
  fs.ensureDirSync(authFolder);

  let sock = null;
  let currentQr = '';
  let isConnected = false;
  const conversations = {};

  // Main async function - Baileys is ESM so we use dynamic import
  async function startBot() {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DisconnectReason,
    } = await import('@whiskeysockets/baileys');
    const pino = (await import('pino')).default;
    const { Boom } = await import('@hapi/boom');

    const logger = pino({ level: 'silent' }); // Reduce noise, set to 'info' for debugging

    console.log('🚀 Starting Baileys WhatsApp Bot...');
    console.log('   (No Chrome/browser needed - uses WebSocket directly)\n');

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: true,
    });

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 QR Code received - scan at http://localhost:' + PORT + '/qr');
        try {
          const dataUrl = await qrcode.toDataURL(qr);
          currentQr = dataUrl;
          await qrcode.toFile(path.join(qrFolder, 'last_qr.png'), qr);
        } catch (e) {
          currentQr = qr; // fallback to raw
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : 0;

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log('🔄 Reconnecting in 10 seconds (delay helps avoid "could not link device" errors)...');
          setTimeout(() => startBot(), 10000);
        } else {
          console.log('❌ Logged out - clearing auth for fresh QR...');
          try {
            if (fs.existsSync(authFolder)) {
              fs.removeSync(authFolder);
              console.log('   Auth cleared. Restarting to show fresh QR in 5 seconds...');
              setTimeout(() => startBot(), 5000);
            }
          } catch (e) {
            console.log('   Could not clear auth:', e.message);
          }
        }
        isConnected = false;
      } else if (connection === 'open') {
        isConnected = true;
        currentQr = '';
        console.log('\n✅✅✅ CONNECTED! Bot is ready to receive messages.\n');
      }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages - THIS IS THE KEY: Baileys receives messages reliably!
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          // Skip if message is from us
          if (msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;
          if (!jid) continue;

          // Skip groups
          if (jid.endsWith('@g.us')) continue;

          // Skip status broadcasts
          if (jid === 'status@broadcast') continue;

          // Extract text
          const msgContent = msg.message;
          if (!msgContent) continue;

          const text = msgContent.conversation
            || msgContent.extendedTextMessage?.text
            || msgContent.imageMessage?.caption
            || '';

        const isImage = !!msgContent.imageMessage;
        const isDocument = !!msgContent.documentMessage;
        const isMedia = isImage || isDocument;

        console.log('\n🔔🔔🔔 MESSAGE RECEIVED (Baileys)! 🔔🔔🔔');
        console.log('   From:', jid);
        console.log('   Body:', (text || (isMedia ? '(media)' : '')).substring(0, 80));
        console.log('   Processing...\n');

        await processMessage(sock, jid, { text: text.trim(), isImage, isDocument, isMedia, rawMsg: msg });
        } catch (err) {
          console.error('❌ Error processing message:', err);
        }
      }
    });

    return sock;
  }

  async function processMessage(sock, sender, { text, isImage, isDocument, isMedia, rawMsg }) {
    if (!conversations[sender]) {
      console.log('[New] Starting conversation with', sender);
      conversations[sender] = { step: 0 };
    }

    const state = conversations[sender];

    try {
      switch (state.step) {
        case 0:
          console.log('📤 Sending welcome message to', sender);
          await sock.sendMessage(sender, {
            text: 'Hello 👋\nThank you for contacting Giga Advisory Group.\nWe help individuals with USA visa and immigration services.\nTo assist you better, please answer a few quick questions.\nType START to begin.',
          });
          state.step = 1;
          break;

        case 1:
          if (text.toUpperCase().trim() !== 'START') {
            await sock.sendMessage(sender, { text: 'Please type START to begin.' });
            return;
          }
          console.log('📤 Sending visa type question to', sender);
          await sock.sendMessage(sender, {
            text: 'What type of visa are you interested in?\n• Work Visa\n• Study Visa\n• Visit Visa\n• Immigration / PR\n• Business / Investor Visa',
          });
          state.step = 2;
          break;

        case 2:
          state.visaType = text;
          console.log('📤 Sending age question to', sender);
          await sock.sendMessage(sender, {
            text: "What is your age?\n• 18 – 24\n• 25 – 34\n• 35 – 44\n• 45+",
          });
          state.step = 3;
          break;

        case 3:
          state.age = text;
          console.log('📤 Sending education question to', sender);
          await sock.sendMessage(sender, {
            text: "What is your highest education level?\n• High School\n• Diploma\n• Bachelor's Degree\n• Master's Degree\n• Other",
          });
          state.step = 4;
          break;

        case 4:
          state.education = text;
          console.log('📤 Sending work experience question to', sender);
          await sock.sendMessage(sender, {
            text: 'How many years of work experience do you have?\n• No experience\n• 1 – 2 years\n• 3 – 5 years\n• 5+ years',
          });
          state.step = 5;
          break;

        case 5:
          state.workExperience = text;
          console.log('📤 Sending English test question to', sender);
          await sock.sendMessage(sender, {
            text: 'Have you taken an English test like IELTS or PTE?\n• Yes\n• No\n• Planning to take',
          });
          state.step = 6;
          break;

        case 6:
          state.englishTest = text;
          console.log('📤 Sending occupation question to', sender);
          await sock.sendMessage(sender, {
            text: 'What is your current occupation / profession?\n• IT / Software\n• Engineer\n• Healthcare / Medical\n• Business / Finance\n• Sales / Marketing\n• Skilled Trade (Electrician, Plumber, etc.)\n• Student\n• Other',
          });
          state.step = 7;
          break;

        case 7:
          state.occupation = text;
          console.log('📤 Requesting full name from', sender);
          await sock.sendMessage(sender, {
            text: 'Great! One of our immigration advisors will review your details.\nPlease share your Full Name.',
          });
          state.step = 8;
          break;

        case 8:
          state.fullName = text;
          console.log('📤 Requesting email from', sender);
          await sock.sendMessage(sender, { text: 'Please share your Email Address.' });
          state.step = 9;
          break;

        case 9:
          state.email = text;
          console.log('📤 Sending final message to', sender);
          await sock.sendMessage(sender, {
            text: 'Thank you for submitting your information ✅\nOur immigration consultants will review your details and contact you within 24 hours.\nPlease keep an eye on the email address you provided, as our team may also reach out via email with further details.\nIf you have any documents ready (CV, IELTS result, passport copy), you may share them here to speed up your assessment.\nHave a great day!',
          });
          state.step = 10;
          break;

        case 10:
          if (isMedia) {
            console.log('📥 Receiving document from', sender);
            try {
              const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
              const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
              const safeSender = (sender || '').replace(/@c\.us|@s\.whatsapp\.net/g, '');
              const ext = isImage ? '.jpg' : '.pdf';
              const docPath = `./receipts/${safeSender}_doc_${Date.now()}${ext}`;
              fs.writeFileSync(docPath, buffer);
              await sock.sendMessage(sender, { text: 'Thanks, we\'ve received your document.' });
            } catch (mediaErr) {
              console.error('❌ Error processing document:', mediaErr);
              await sock.sendMessage(sender, { text: '⚠️ Error processing document. Please try again.' });
            }
          } else {
            await sock.sendMessage(sender, {
              text: 'If you have any documents ready (CV, IELTS result, passport copy), you may share them here to speed up your assessment.',
            });
          }
          break;

        default:
          conversations[sender] = { step: 0 };
          await sock.sendMessage(sender, { text: "Something went wrong. Let's start over." });
      }
    } catch (err) {
      console.error('❌ Error:', err);
      try {
        await sock.sendMessage(sender, { text: '⚠️ Internal error. Please try again.' });
      } catch (e) {}
    }
  }

  // Web routes
  app.get('/qr', (req, res) => {
    try {
      const qrPath = path.join(process.cwd(), qrFolder, 'last_qr.png');
      const qrExists = fs.existsSync(qrPath);

      let content = '';
      if (currentQr && !isConnected && typeof currentQr === 'string' && currentQr.startsWith('data:')) {
        content = `<img src="${currentQr}" style="max-width:400px;" alt="QR Code" />`;
      } else if (qrExists && !isConnected) {
        content = `<img src="/qr-image?t=${Date.now()}" style="max-width:400px;" alt="QR Code" />`;
      } else if (isConnected) {
        content = '<p style="color:green;font-size:18px;">✅ Connected! Bot is ready.</p>';
      } else {
        content = '<p>Waiting for QR code... Check terminal for QR if this shows too long.</p>';
      }

      res.setHeader('Content-Type', 'text/html');
      res.send(`<!DOCTYPE html>
  <html>
  <head><title>Giga Advisory Group</title><meta http-equiv="refresh" content="20"></head>
  <body style="font-family:Arial;text-align:center;padding:20px;">
    <h1>Giga Advisory Group</h1>
    ${content}
    <p>Status: ${isConnected ? '✅ Connected' : '⏳ Scan QR to connect'}</p>
  <p style="color:#666;font-size:12px;">Page refreshes every 20 sec. If you see "could not link device", wait 10–15 sec then try again.</p>
  </body>
  </html>`);
    } catch (err) {
      console.error('Error in /qr route:', err);
      res.status(500).send('Server error: ' + (err.message || 'Unknown'));
    }
  });

  app.get('/qr-image', (req, res) => {
    try {
      const qrPath = path.join(process.cwd(), qrFolder, 'last_qr.png');
      if (fs.existsSync(qrPath)) {
        res.sendFile(qrPath);
      } else {
        res.status(404).send('QR not found');
      }
    } catch (err) {
      console.error('Error in /qr-image route:', err);
      res.status(500).send('Error');
    }
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).send('Server error');
  });

  // Start
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('🌐 Server: http://localhost:' + PORT + '/qr');
    console.log('🔄 Connecting to WhatsApp...\n');
    startBot().catch((err) => {
      console.error('Failed to start Baileys:', err);
      console.log('Server is still running. QR will work once Baileys connects.');
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('❌ Port', PORT, 'is already in use. Stop the other process first.');
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });
