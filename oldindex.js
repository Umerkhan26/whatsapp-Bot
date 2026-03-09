require('dotenv').config();
const os = require('os');
const fs = require('fs-extra');
const express = require('express');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cloudinary = require('cloudinary').v2;
const { appendRow } = require('./googleSheets');

const app = express();
const PORT = process.env.PORT || 40001;
const receiptsDir = './receipts';
const isLinux = process.platform === 'linux';

fs.ensureDirSync(receiptsDir);

let lastQrData = '';
let lastQrAscii = '';
let deviceConnected = false;

// Simple in-memory status for WhatsApp connection
let waStatus = {
  connected: false,
  lastEvent: 'init',
  lastChange: new Date().toISOString(),
  reason: null,
};

function updateStatus(partial) {
  waStatus = {
    ...waStatus,
    ...partial,
    lastChange: new Date().toISOString(),
  };
  // Log a concise status line to the terminal whenever WhatsApp state changes
  const base = `WA STATUS -> connected=${waStatus.connected} event=${waStatus.lastEvent}`;
  const reasonPart = waStatus.reason ? ` reason=${waStatus.reason}` : '';
  console.log(base + reasonPart);
}

// Get local IP (for convenience logging)
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (let name of Object.keys(nets)) {
    for (let n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return 'localhost';
}
const localIp = getLocalIp();

// Cloudinary config (values come from .env)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// WhatsApp Web client (whatsapp-web.js)
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './tokens/wwebjs' }),
  puppeteer: {
    // On Linux servers (like your Ubuntu host), run headless so no X server is required.
    // On Windows/macOS desktop, show the browser window.
    headless: isLinux,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

// Conversation states per sender
const convos = {};

client.on('qr', qr => {
  lastQrData = qr;
  updateStatus({ connected: false, lastEvent: 'qr', reason: null });
  console.clear();
  console.log('📲 Scan this QR code with WhatsApp:');
  qrcode.generate(qr, { small: true }, ascii => {
    lastQrAscii = ascii;
    console.log(ascii);
  });
  console.log(`\n🖼️ Also open http://${localIp}:${PORT}/qr in a browser.`);
});

client.on('authenticated', async () => {
  console.log('🔐 Authenticated with WhatsApp');
  updateStatus({ lastEvent: 'authenticated', reason: null });
  
  // Workaround: Since ready event sometimes doesn't fire, check state multiple times
  // and if authenticated for 30+ seconds, assume it's ready
  let checkCount = 0;
  const maxChecks = 6; // Check 6 times over 30 seconds
  
  const checkState = async () => {
    // Don't check if already connected
    if (deviceConnected) {
      return;
    }
    
    try {
      const state = await client.getState();
      checkCount++;
      console.log(`🔍 Check ${checkCount}/${maxChecks} - Client state: ${state || 'null/undefined'}`);
      
      if (state === 'CONNECTED' && !deviceConnected) {
        console.log('✅ Client is CONNECTED! Manually setting as ready...');
        deviceConnected = true;
        console.log('✅ WhatsApp client is ready and listening for messages');
        updateStatus({ connected: true, lastEvent: 'ready', reason: null });
        return; // Stop checking
      }
      
      // If we've checked multiple times and still not ready, but authenticated
      // Assume it's ready after 30 seconds (6 checks * 5 seconds)
      if (checkCount >= maxChecks && !deviceConnected) {
        console.log('⏰ Authenticated for 30+ seconds. Assuming client is ready...');
        console.log('💡 If messages don\'t work, try restarting the bot');
        deviceConnected = true;
        console.log('✅ WhatsApp client is ready and listening for messages');
        updateStatus({ connected: true, lastEvent: 'ready', reason: 'timeout_fallback' });
        return;
      }
      
      // Continue checking if not ready yet
      if (!deviceConnected && checkCount < maxChecks) {
        setTimeout(checkState, 5000); // Check every 5 seconds
      }
    } catch (err) {
      // Handle "Execution context was destroyed" and other errors gracefully
      if (err.message && err.message.includes('Execution context was destroyed')) {
        console.log(`⏸️  Browser context not ready yet (attempt ${checkCount + 1})`);
      } else {
        console.error(`❌ Error checking state (attempt ${checkCount + 1}):`, err.message || err);
      }
      
      // Continue checking even on error, but only if not ready yet
      if (!deviceConnected && checkCount < maxChecks) {
        setTimeout(checkState, 5000);
      } else if (checkCount >= maxChecks && !deviceConnected) {
        // After max checks, assume ready anyway
        console.log('⏰ Authenticated for 30+ seconds. Assuming client is ready (despite errors)...');
        deviceConnected = true;
        console.log('✅ WhatsApp client is ready and listening for messages');
        updateStatus({ connected: true, lastEvent: 'ready', reason: 'timeout_fallback_after_errors' });
      }
    }
  };
  
  // Start checking after 5 seconds
  setTimeout(checkState, 5000);
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Loading: ${percent}% - ${message || 'Loading WhatsApp Web...'}`);
});

client.on('ready', () => {
  deviceConnected = true;
  console.log('✅ WhatsApp client is ready and listening for messages');
  console.log('🔍 DEBUG: Message handler should be registered. Testing...');
  
  // Verify message handler is registered
  const listeners = client.listeners('message');
  console.log(`🔍 DEBUG: Number of 'message' event listeners: ${listeners.length}`);
  if (listeners.length === 0) {
    console.error('❌ WARNING: No message event listeners found! Message handler may not be registered!');
  } else {
    console.log(`✅ Message event listener is registered (${listeners.length} listener(s))`);
  }
  
  // Force verify connection is actually working
  setTimeout(async () => {
    try {
      const state = await client.getState();
      console.log(`🔍 DEBUG: Client state after ready: ${state}`);
      if (state === 'CONNECTED') {
        console.log('✅ Client is confirmed CONNECTED and ready for messages');
      } else {
        console.log(`⚠️ Client state is ${state}, not CONNECTED. Messages may not work.`);
      }
    } catch (err) {
      console.log(`⚠️ Could not verify state: ${err.message}`);
    }
  }, 2000);
  
  updateStatus({ connected: true, lastEvent: 'ready', reason: null });
});

client.on('auth_failure', msg => {
  console.error('❌ Authentication failure:', msg);
  updateStatus({ connected: false, lastEvent: 'auth_failure', reason: String(msg) });
});

client.on('disconnected', reason => {
  console.error('⚠️ WhatsApp client disconnected:', reason);
  deviceConnected = false;
  updateStatus({ connected: false, lastEvent: 'disconnected', reason: String(reason) });
});

// Catch any client errors
client.on('change_state', state => {
  console.log(`🔄 Client state changed: ${state}`);
});

// Log any errors (but don't crash on Execution context errors)
process.on('unhandledRejection', (reason, promise) => {
  if (reason && reason.message && reason.message.includes('Execution context was destroyed')) {
    // This is common during initialization, just log it
    console.log('⚠️  Browser context was destroyed (this is normal during initialization)');
  } else {
    console.error('❌ Unhandled Rejection:', reason);
  }
});

// Message handling logic
client.on('message', async msg => {
  console.log(`🔔🔔🔔 MESSAGE EVENT TRIGGERED! 🔔🔔🔔`);
  console.log(`   From: ${msg.from}`);
  console.log(`   Type: ${msg.type}`);
  console.log(`   HasMedia: ${msg.hasMedia}`);
  console.log(`   Body: ${(msg.body || '').substring(0, 100)}`);
  console.log(`🔍 DEBUG: deviceConnected = ${deviceConnected}, waStatus.connected = ${waStatus.connected}`);
  
  // ALWAYS check client state - don't rely on deviceConnected flag alone
  let actualState = null;
  try {
    actualState = await client.getState();
    console.log(`🔍 DEBUG: Actual client state: ${actualState}`);
  } catch (stateErr) {
    console.log(`🔍 DEBUG: Could not get state: ${stateErr.message}`);
  }
  
  // If client is CONNECTED, process the message regardless of deviceConnected flag
  if (actualState === 'CONNECTED') {
    if (!deviceConnected) {
      console.log(`⚠️  Client is CONNECTED but deviceConnected flag is false! Fixing...`);
      deviceConnected = true;
      updateStatus({ connected: true, lastEvent: 'ready', reason: 'message_handler_fix' });
      console.log(`✅ Fixed deviceConnected flag`);
    }
    console.log(`✅ Client is CONNECTED, proceeding to process message...`);
  } else if (!deviceConnected) {
    console.log(`⏸️  Message received but client not ready (state: ${actualState}). Ignoring...`);
    return;
  } else {
    console.log(`✅ deviceConnected is true, proceeding to process message...`);
  }

  try {
    // Double-check client state before processing
    let actualState = null;
    try {
      actualState = await client.getState();
      console.log(`🔍 DEBUG: Actual client state when message received: ${actualState}`);
    } catch (stateErr) {
      console.log(`🔍 DEBUG: Could not get state: ${stateErr.message}`);
    }
    
    // If state is null/undefined but deviceConnected is true (from timeout fallback),
    // try to process anyway - the client might still work
    if (!actualState && deviceConnected) {
      console.log(`⚠️  Client state is null but deviceConnected is true (timeout fallback). Attempting to process message anyway...`);
    }

    // Ignore messages from groups
    if (msg.from.includes('@g.us')) {
      console.log(`[Ignored] Group message from ${msg.from}`);
      return;
    }

    // Ignore messages from status broadcasts
    if (msg.from === 'status@broadcast') {
      console.log(`[Ignored] Status broadcast message`);
      return;
    }

    // Ignore messages sent by the bot itself
    try {
      const contact = await msg.getContact();
      if (contact.isMe) {
        console.log(`[Ignored] Message from bot itself`);
        return;
      }
      console.log(`✅ Contact check passed - not from bot itself`);
    } catch (e) {
      // If we can't get contact, continue anyway
      console.log(`[Warning] Could not get contact info: ${e.message} - continuing anyway`);
    }

    const sender = msg.from;
    const text = (msg.body || '').trim();
    const lowerText = text.toLowerCase();

    console.log(`📨 Processing message from ${sender}: "${text}"`);
    console.log(`🔍 DEBUG: Message body length: ${text.length}, hasMedia: ${msg.hasMedia}, type: ${msg.type}`);

    if (!convos[sender]) {
      console.log(`[New] Starting conversation with ${sender}`);
      convos[sender] = { step: 0 };
    }

    let state = convos[sender];

    console.log(`🔍 DEBUG: Current conversation step: ${state.step}`);
    switch (state.step) {
      case 0:
        console.log(`📤 Sending welcome message to ${sender}...`);
        try {
          const welcomeMsg = 'Hi 👋\nWelcome to the Pinehill $60,000 Kitchen Makeover Promotion!\nTo enter, please answer the following questions.\n\nPlease enter your Full Name (First & Last Name)';
          console.log(`🔍 DEBUG: About to send reply, message length: ${welcomeMsg.length}`);
          console.log(`🔍 DEBUG: Using msg.reply() method...`);
          
          // Try to send the reply
          const replyResult = await msg.reply(welcomeMsg);
          console.log(`✅ Welcome message sent successfully to ${sender}`);
          console.log(`🔍 DEBUG: Reply result:`, replyResult ? 'Success' : 'No result');
          state.step = 1;
          console.log(`🔍 DEBUG: Updated step to ${state.step}`);
        } catch (replyErr) {
          console.error(`❌ Error sending welcome message:`, replyErr);
          console.error(`❌ Reply error message:`, replyErr.message);
          console.error(`❌ Reply error stack:`, replyErr.stack);
          console.error(`❌ Full error object:`, JSON.stringify(replyErr, Object.getOwnPropertyNames(replyErr)));
          
          // Try alternative method if reply fails
          try {
            console.log(`🔄 Trying alternative send method (client.sendMessage)...`);
            await client.sendMessage(msg.from, welcomeMsg);
            console.log(`✅ Message sent using alternative method`);
            state.step = 1;
          } catch (altErr) {
            console.error(`❌ Alternative send method also failed:`, altErr.message);
            throw replyErr; // Throw original error
          }
        }
        break;

      case 1:
        state.fullName = text;
        await msg.reply('Please enter your Contact Number.');
        state.step = 2;
        break;

      case 2:
        state.contactNumber = text;
        await msg.reply('How many letters are in the word \'Milk\'?');
        state.step = 3;
        break;

      case 3:
        if (text === '4') {
          state.verificationAnswer = text;
          await msg.reply('Please upload a clear photo of your receipt showing:\n• Date of purchase\n• Store name\n• Pinehill Evaporated Milk purchase');
          state.step = 4;
        } else {
          await msg.reply('❌ Incorrect answer. Please try again.\n\nHow many letters are in the word \'Milk\'?');
        }
        break;

      case 4:
        if (msg.hasMedia && msg.type === 'image') {
          const media = await msg.downloadMedia();
          const buffer = Buffer.from(media.data, 'base64');
          const receiptPath = `${receiptsDir}/${sender.replace('@c.us', '')}_receipt_${Date.now()}.jpg`;

          fs.writeFileSync(receiptPath, buffer);
          state.receiptPath = receiptPath;

          // Upload to Cloudinary and store public URL
          try {
            const uploadResult = await new Promise((resolve, reject) => {
              const stream = cloudinary.uploader.upload_stream(
                { folder: 'receipts' },
                (err, result) => (err ? reject(err) : resolve(result))
              );
              stream.end(buffer);
            });
            state.receiptUrl = uploadResult.secure_url;
            console.log('✅ Uploaded receipt to Cloudinary:', state.receiptUrl);
          } catch (e) {
            console.error('❌ Failed to upload receipt to Cloudinary:', e);
            state.receiptUrl = '';
          }

          // Auto-submit after receipt upload
          await msg.reply('Thank you! 🎉\nYour entry has been received.\nIf your submission meets all promotional requirements, you will be entered into the draw.\nPromotion ends April 30, 2026.\nT&Cs Apply.\nPinehill. Made at Home Since 1966.');

          const timestamp = new Date().toISOString();
          const phone = sender.replace('@c.us', '');

          // Log to Google Sheet: [Timestamp, Phone, Full Name, Contact Number, Verification Answer, Cloudinary URL]
          appendRow([
            timestamp,
            phone,
            state.fullName || '',
            state.contactNumber || '',
            state.verificationAnswer || '',
            state.receiptUrl || state.receiptPath || '',
          ]);

          console.log(`✅ Conversation complete. Logged to sheet and clearing state for ${sender}`);
          delete convos[sender];
          state = null;
        } else {
          await msg.reply('📷 Please upload a clear photo of your receipt showing:\n• Date of purchase\n• Store name\n• Pinehill Evaporated Milk purchase');
        }
        break;

      default:
        await msg.reply('❓ Something went wrong. Let\'s start over.');
        convos[sender] = { step: 0 };
        break;
    }
  } catch (err) {
    console.error(`❌ Error processing message from ${msg.from}:`, err);
    console.error(`❌ Error message:`, err.message);
    console.error(`❌ Error stack:`, err.stack);
    console.error(`❌ Full error object:`, JSON.stringify(err, Object.getOwnPropertyNames(err)));
    try {
      await msg.reply('⚠️ Internal error. Please try again.');
      console.log(`✅ Error reply sent successfully`);
    } catch (replyErr) {
      console.error(`❌ Failed to send error reply:`, replyErr);
      console.error(`❌ Reply error stack:`, replyErr.stack);
    }
  }
});

// Simple QR page
app.get('/qr', (req, res) => {
  const qrImg = lastQrData
    ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(
        lastQrData
      )}" />`
    : '<p>No QR yet. Start the bot and wait for QR to generate.</p>';

  res.send(`
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>WhatsApp Login QR</title>
        <style>
          body {
            text-align: center;
            font-family: Arial, sans-serif;
            background-color: #f5f5f5;
            padding-top: 40px;
          }
          #wa-status {
            margin-top: 20px;
            font-weight: bold;
            padding: 10px 16px;
            border-radius: 6px;
            display: inline-block;
          }
          .status-connected {
            background-color: #e6ffed;
            color: #1f7a1f;
            border: 1px solid #1f7a1f;
          }
          .status-disconnected {
            background-color: #ffecec;
            color: #a11;
            border: 1px solid #a11;
          }
          .status-pending {
            background-color: #fff8e1;
            color: #8a6d3b;
            border: 1px solid #8a6d3b;
          }
        </style>
      </head>
      <body>
        <h2>WhatsApp Login QR</h2>
        ${qrImg}
        <p style="margin-top:1em;">You can also scan the QR shown in the terminal.</p>

        <div id="wa-status" class="status-pending">
          Checking WhatsApp status...
        </div>

        <script>
          async function refreshStatus() {
            try {
              const res = await fetch('/status');
              if (!res.ok) throw new Error('HTTP ' + res.status);
              const data = await res.json();

              const el = document.getElementById('wa-status');
              if (!el) return;

              el.classList.remove('status-connected', 'status-disconnected', 'status-pending');

              if (data.connected) {
                el.textContent = 'WhatsApp Status: CONNECTED';
                el.classList.add('status-connected');
              } else {
                const event = data.lastEvent || 'unknown';
                el.textContent = 'WhatsApp Status: ' + event.toUpperCase();
                el.classList.add(event === 'ready' ? 'status-connected' : 'status-disconnected');
              }
            } catch (e) {
              const el = document.getElementById('wa-status');
              if (el) {
                el.textContent = 'Unable to fetch WhatsApp status';
                el.classList.remove('status-connected', 'status-disconnected');
                el.classList.add('status-pending');
              }
            }
          }

          // Initial fetch and poll every 3 seconds
          refreshStatus();
          setInterval(refreshStatus, 3000);
        </script>
      </body>
    </html>
  `);
});

// Lightweight status endpoint so admin frontend can see WhatsApp connection state
// Example JSON: { connected: true, lastEvent: 'ready', lastChange: '...', reason: null }
app.get('/status', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // allow cross-origin reads
  res.json({
    connected: waStatus.connected,
    lastEvent: waStatus.lastEvent,
    lastChange: waStatus.lastChange,
    reason: waStatus.reason,
  });
});

// Endpoint to clear session (useful for debugging)
app.post('/clear-session', (req, res) => {
  try {
    const tokensPath = './tokens/wwebjs';
    if (fs.existsSync(tokensPath)) {
      fs.removeSync(tokensPath);
      console.log('🗑️ Session cleared. Restart the bot to re-authenticate.');
      res.json({ success: true, message: 'Session cleared. Please restart the bot.' });
    } else {
      res.json({ success: false, message: 'Session folder not found.' });
    }
  } catch (err) {
    console.error('❌ Error clearing session:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint to check if client is actually functional
app.get('/check-client', async (req, res) => {
  try {
    const info = await client.getState();
    const isReady = deviceConnected;
    const listeners = client.listeners('message');
    res.json({
      state: info,
      deviceConnected: isReady,
      waStatus: waStatus,
      messageListeners: listeners.length,
      message: isReady ? 'Client is ready' : `Client state: ${info}, but ready event not fired yet`
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      deviceConnected: deviceConnected,
      waStatus: waStatus
    });
  }
});

// Test endpoint to check if client can send messages
app.get('/test-send', async (req, res) => {
  try {
    const testNumber = req.query.number; // e.g., ?number=1234567890@c.us
    if (!testNumber) {
      return res.json({ error: 'Please provide ?number=1234567890@c.us parameter' });
    }
    
    console.log(`🧪 Test: Attempting to send message to ${testNumber}`);
    const state = await client.getState();
    console.log(`🧪 Test: Client state: ${state}`);
    console.log(`🧪 Test: deviceConnected: ${deviceConnected}`);
    
    try {
      await client.sendMessage(testNumber, '🧪 Test message from bot');
      res.json({ success: true, message: 'Test message sent successfully' });
    } catch (sendErr) {
      res.json({ success: false, error: sendErr.message, state, deviceConnected });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Endpoint to force logout and re-sync (WARNING: This will logout from mobile WhatsApp too!)
app.post('/force-logout', async (req, res) => {
  try {
    console.log('🔄 Force logout requested...');
    console.log('⚠️ WARNING: This will logout from your mobile WhatsApp too!');
    deviceConnected = false;
    updateStatus({ connected: false, lastEvent: 'force_logout', reason: null });
    
    await client.logout();
    console.log('✅ Logged out. Re-initializing in 3 seconds...');
    
    setTimeout(() => {
      client.initialize().catch(err => {
        console.error('❌ Failed to reinitialize:', err);
      });
    }, 3000);
    
    res.json({ success: true, message: 'Logout initiated. Re-initializing in 3 seconds...' });
  } catch (err) {
    console.error('❌ Error during force logout:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Express + WhatsApp client
app.listen(PORT, () => {
  console.log(`🌐 Server running at: http://0.0.0.0:${PORT}/qr`);
  client.initialize();
});