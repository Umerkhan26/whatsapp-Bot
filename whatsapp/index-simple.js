require('dotenv').config();
const venom = require('venom-bot');
const express = require('express');
const fs = require('fs-extra');

const app = express();
const PORT = process.env.PORT || 3000;
const session = 'session';
const tokenFolder = './tokens';
const qrFolder = './qrcodes';

fs.ensureDirSync(qrFolder);
fs.ensureDirSync('./receipts');

let client = null;
let currentQr = '';
let isConnected = false;
const conversations = {};

// Simple QR handler
function qrHandler(base64Qr) {
  console.log('📱 QR Code received!');
  currentQr = `data:image/png;base64,${base64Qr}`;
  
  try {
    fs.writeFileSync(`${qrFolder}/last_qr.png`, base64Qr, 'base64');
    console.log('✅ QR code saved');
  } catch (err) {
    console.log('⚠️ Could not save QR:', err.message);
  }
  
  console.log(`🖼️ QR code: http://localhost:${PORT}/qr`);
}

// Simple status callback
function statusCallback(statusSession, session) {
  console.log(`Status: ${statusSession}, Session: ${session}`);
  
  if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess' || statusSession === 'chatsAvailable') {
    if (!isConnected) {
      isConnected = true;
      console.log('✅✅✅ CONNECTED! Starting message listener...');
      startMessageListener();
    }
  }
}

// Start message listener - SIMPLE VERSION
function startMessageListener() {
  if (messageListenerActive) {
    console.log('⚠️ Message listener already active, skipping...');
    return;
  }
  
  if (!client) {
    console.log('❌ No client available for listener');
    return;
  }
  
  messageListenerActive = true;
  console.log('👂 Starting message listener...');
  console.log('   Client type:', typeof client);
  console.log('   Client.onMessage type:', typeof client.onMessage);
  
  // Verify client has onMessage
  if (typeof client.onMessage !== 'function') {
    console.log('❌ client.onMessage is not a function!');
    messageListenerActive = false;
    return;
  }
  
  client.onMessage(async (message) => {
    try {
      console.log(`\n🔔🔔🔔 MESSAGE EVENT FIRED! 🔔🔔🔔`);
      console.log(`   From: ${message.from}`);
      console.log(`   Body: ${message.body || '(no body)'}`);
      console.log(`   Type: ${message.type || 'unknown'}`);
      console.log(`   FromMe: ${message.fromMe || false}`);
      console.log(`   IsGroup: ${message.from?.includes('@g.us') || false}`);
      
      // Skip groups and status
      if (message.from && message.from.includes('@g.us')) {
        console.log('   [Skipped] Group message');
        return;
      }
      
      if (message.from === 'status@broadcast') {
        console.log('   [Skipped] Status broadcast');
        return;
      }
      
      // Skip own messages
      if (message.fromMe) {
        console.log('   [Skipped] Own message');
        return;
      }
      
      console.log(`   ✅ Processing message from ${message.from}`);
      
      const sender = message.from;
      const text = (message.body || '').trim();
      
      // Initialize conversation
      if (!conversations[sender]) {
        conversations[sender] = { step: 0 };
      }
      
      const state = conversations[sender];
      
      // Process based on step
      console.log(`   Current step: ${state.step}`);
      switch (state.step) {
        case 0:
          console.log('📤 Sending welcome message...');
          try {
            const result = await client.sendText(sender, 'Hi 👋\nWelcome to the Pinehill $60,000 Kitchen Makeover Promotion!\nTo enter, please answer the following questions.\n\nPlease enter your Full Name (First & Last Name)');
            console.log('✅ Welcome message sent!');
            console.log('   Send result:', result ? 'OK' : 'No result');
            state.step = 1;
          } catch (sendErr) {
            console.error('❌ Failed to send welcome message:', sendErr);
            console.error('   Error details:', sendErr.message);
            throw sendErr;
          }
          break;
          
        case 1:
          state.fullName = text;
          console.log('📤 Asking for contact number...');
          await client.sendText(sender, 'Please enter your Contact Number.');
          state.step = 2;
          break;
          
        case 2:
          state.contactNumber = text;
          console.log('📤 Asking verification question...');
          await client.sendText(sender, 'How many letters are in the word \'Milk\'?');
          state.step = 3;
          break;
          
        case 3:
          if (text === '4') {
            state.verificationAnswer = text;
            console.log('📤 Asking for receipt...');
            await client.sendText(sender, 'Please upload a clear photo of your receipt showing:\n• Date of purchase\n• Store name\n• Pinehill Evaporated Milk purchase');
            state.step = 4;
          } else {
            console.log('❌ Wrong answer, asking again...');
            await client.sendText(sender, '❌ Incorrect answer. Please try again.\n\nHow many letters are in the word \'Milk\'?');
          }
          break;
          
        case 4:
          if (message.isMedia && message.type === 'image') {
            console.log('📥 Receiving image...');
            try {
              const media = await client.decryptFile(message);
              const receiptPath = `./receipts/${sender.replace('@c.us', '')}_receipt_${Date.now()}.jpg`;
              fs.writeFileSync(receiptPath, media);
              console.log(`✅ Receipt saved: ${receiptPath}`);
              
              await client.sendText(sender, 'Thank you! 🎉\nYour entry has been received.\nIf your submission meets all promotional requirements, you will be entered into the draw.\nPromotion ends April 30, 2026.\nT&Cs Apply.\nPinehill. Made at Home Since 1966.');
              
              delete conversations[sender];
            } catch (mediaErr) {
              console.error('❌ Error processing image:', mediaErr);
              await client.sendText(sender, '⚠️ Error processing image. Please try uploading again.');
            }
          } else {
            await client.sendText(sender, '📷 Please upload a clear photo of your receipt showing:\n• Date of purchase\n• Store name\n• Pinehill Evaporated Milk purchase');
          }
          break;
      }
      
      console.log('✅ Message processed successfully');
    } catch (err) {
      console.error('❌❌❌ ERROR in message handler:');
      console.error('   Error:', err.message);
      console.error('   Stack:', err.stack);
      console.error('   Full error:', err);
    }
  });
  
  console.log('✅✅✅ Message listener registered and active!');
  console.log('   Waiting for messages...');
  
  // Test if listener is actually working by checking after 2 seconds
  setTimeout(() => {
    console.log('🔍 Listener check: client.onMessage registered:', typeof client.onMessage === 'function');
  }, 2000);
}

// Initialize client
async function initClient() {
  try {
    // Clear old session
    const sessionPath = `${tokenFolder}/${session}`;
    if (fs.existsSync(sessionPath)) {
      console.log('🧹 Clearing old session...');
      fs.removeSync(sessionPath, { force: true });
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('🚀 Creating WhatsApp client...');
    
    client = await venom.create(
      {
        session: session,
        multidevice: true,
        folderNameToken: tokenFolder,
        disableWelcome: true,
        headless: false, // Set to true for production
      },
      qrHandler,
      statusCallback
    );
    
    console.log('✅ Client created!');
    
    // Wait a bit then check if connected and start listener
    setTimeout(async () => {
      try {
        const isLoggedIn = await client.isLoggedIn();
        console.log(`🔍 Checking connection status: isLoggedIn=${isLoggedIn}, isConnected=${isConnected}`);
        
        if (isLoggedIn && !isConnected) {
          console.log('✅ Already logged in! Starting listener...');
          isConnected = true;
          startMessageListener();
        } else if (isLoggedIn && isConnected && !messageListenerActive) {
          console.log('⚠️ Connected but listener not active, starting now...');
          startMessageListener();
        }
      } catch (err) {
        console.log('⏳ Waiting for connection...', err.message);
      }
    }, 3000);
    
    // Also try starting listener after status callback confirms connection
    setTimeout(() => {
      if (isConnected && client && !messageListenerActive) {
        console.log('🔄 Double-check: Starting listener from timeout...');
        startMessageListener();
      }
    }, 5000);
    
  } catch (err) {
    console.error('❌ Error creating client:', err);
    console.log('🔄 Retrying in 5 seconds...');
    setTimeout(() => {
      initClient();
    }, 5000);
  }
}

// Web routes
app.get('/qr', (req, res) => {
  const qrPath = `${qrFolder}/last_qr.png`;
  const qrExists = fs.existsSync(qrPath);
  
  let imgTag = '';
  if (qrExists) {
    imgTag = `<img src="/qr-image?t=${Date.now()}" style="max-width:400px;" alt="QR Code" />`;
  } else {
    imgTag = '<p>QR code not available yet...</p>';
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp QR</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: Arial; text-align: center; padding: 20px; }
      </style>
    </head>
    <body>
      <h1>WhatsApp Bot</h1>
      ${imgTag}
      <p>Status: ${isConnected ? '✅ Connected' : '⏳ Waiting for QR scan...'}</p>
    </body>
    </html>
  `);
});

app.get('/qr-image', (req, res) => {
  const qrPath = `${qrFolder}/last_qr.png`;
  if (fs.existsSync(qrPath)) {
    res.sendFile(qrPath, { root: process.cwd() });
  } else {
    res.status(404).send('QR not found');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}/qr`);
  console.log('🔄 Initializing WhatsApp...\n');
  initClient();
});

// Error handling
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});
