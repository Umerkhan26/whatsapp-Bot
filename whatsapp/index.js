require('dotenv').config();
const os = require('os');
const fs = require('fs-extra');
const venom = require('venom-bot');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
// Use a unique session name with timestamp to avoid conflicts
// This prevents WhatsApp from seeing multiple connection attempts as the same device
const session = process.env.SESSION_NAME || `session_${Date.now()}`;
const tokenFolder = './tokens';
const qrFolder = './qrcodes';

fs.ensureDirSync(qrFolder);
fs.ensureDirSync('./receipts');

let venomClient = null;
let currentQr = '';
let deviceConnected = false;
let messageListenerActive = false;
let messagePollingActive = false;
let lastMessageIds = new Set(); // Track processed messages

// Verify connection is truly ready - more thorough check
async function verifyConnection() {
  if (!venomClient) return false;
  
  try {
    const isLoggedIn = await venomClient.isLoggedIn();
    if (!isLoggedIn) {
      console.log('   ❌ Not logged in');
      return false;
    }
    
    // Try to get phone number to verify full connection
    try {
      const phoneNumber = await venomClient.getHostDevice();
      if (!phoneNumber || !phoneNumber.id) {
        console.log('   ❌ Cannot get host device');
        return false;
      }
    } catch (err) {
      console.log('   ⚠️ Could not get host device:', err.message);
    }
    
    // Try to get chats - this verifies full connection (not just syncing)
    try {
      const chats = await venomClient.getAllChats();
      if (Array.isArray(chats)) {
        console.log(`   ✅ Connection verified! Can access ${chats.length} chats`);
        return true;
      }
    } catch (err) {
      console.log('   ⚠️ Cannot get chats yet (still syncing):', err.message);
      return false; // Still syncing
    }
  } catch (err) {
    console.log('   ❌ Connection verification failed:', err.message);
  }
  return false;
}

// Poll for new messages as a backup if onMessage doesn't work
async function startMessagePolling(client) {
  if (messagePollingActive) {
    console.log('⚠️ Message polling already active');
    return;
  }
  
  messagePollingActive = true;
  console.log('🔄 Starting message polling as backup...');
  
  let pollCount = 0;
  const pollInterval = setInterval(async () => {
    // Only stop if client is gone - keep polling even before deviceConnected
    // (we register onMessage early, so polling runs until client is ready)
    if (!venomClient) {
      clearInterval(pollInterval);
      messagePollingActive = false;
      console.log('🛑 Stopping message polling (client disconnected)');
      return;
    }
    
    pollCount++;
    
    // Poll every cycle (every 5 sec) - onMessage can be unreliable in venom-bot 5.x
    
    try {
      // Verify client is ready first
      const isLoggedIn = await client.isLoggedIn();
      if (!isLoggedIn) {
        console.log('⚠️ Polling skipped - client not logged in');
        return;
      }
      
      // Get all chats - with better error handling
      let chats;
      try {
        chats = await client.getAllChats();
      } catch (chatsErr) {
        // If getAllChats fails, client might still be syncing
        if (chatsErr.message && chatsErr.message.includes('getMaybeMeUser')) {
          // This is a known error when client is still initializing
          return; // Skip this poll cycle
        }
        throw chatsErr;
      }
      
      if (!Array.isArray(chats) || chats.length === 0) {
        return; // No chats yet
      }
      
      // Check each chat for new messages - first 20 chats (user's new messages often at top)
      for (const chat of chats.slice(0, 20)) {
        try {
          // Verify chat has proper structure
          if (!chat || !chat.id) continue;
          
          const chatId = chat.id._serialized || chat.id;
          if (!chatId) continue;
          
          const messages = await client.getAllMessagesInChat(chatId, false, false);
          
          if (!Array.isArray(messages) || messages.length === 0) continue;
          
          // Process new messages (only last 3 messages)
          for (const msg of messages.slice(-3)) {
            if (!msg || !msg.id) continue;
            
            const msgId = msg.id._serialized || msg.id;
            if (!msgId) continue;
            
            // Skip if already processed
            if (lastMessageIds.has(msgId)) continue;
            
            // Skip if message is from a group
            if (msg.from && msg.from.includes('@g.us')) continue;
            
            // Skip if message is from status
            if (msg.from === 'status@broadcast') continue;
            
            // Skip if message is from ourselves
            if (msg.fromMe) continue;
            
            // Skip if message is too old (more than 5 minutes)
            const msgTime = (msg.timestamp || 0) * 1000;
            if (msgTime > 0 && Date.now() - msgTime > 5 * 60 * 1000) continue;
            
            // Mark as processed
            lastMessageIds.add(msgId);
            
            // Process the message
            console.log(`\n🔔🔔🔔 POLLED MESSAGE FOUND! 🔔🔔🔔`);
            console.log(`   From: ${msg.from}`);
            console.log(`   Body: ${(msg.body || '').substring(0, 100)}`);
            
            // Process message using the same handler
            await processMessage(client, msg);
            
            // Keep only last 100 message IDs
            if (lastMessageIds.size > 100) {
              const firstId = lastMessageIds.values().next().value;
              lastMessageIds.delete(firstId);
            }
          }
        } catch (chatErr) {
          // Skip this chat if error - don't log to avoid spam
          if (chatErr.message && !chatErr.message.includes('getMaybeMeUser')) {
            // Only log non-common errors
          }
        }
      }
    } catch (err) {
      // Only log if it's not the common initialization error
      if (err.message && !err.message.includes('getMaybeMeUser')) {
        console.log(`⚠️ Polling error:`, err.message);
      }
    }
  }, 5000); // Poll every 5 seconds
}

// Get local IP
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

// Detect OS and set browser path accordingly
function getBrowserConfig() {
  const isWindows = process.platform === 'win32';
  const isLinux = process.platform === 'linux';
  
  const config = {
    headless: false, // Set to false to see browser (for debugging)
    autoClose: 0,
  };

  // Set browser path based on OS
  if (isLinux) {
    // Try to find Chromium/Chrome, otherwise let Puppeteer use bundled Chromium
    const fs = require('fs');
    const possiblePaths = [
      '/snap/bin/chromium',  // Snap installation
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable'
    ];
    
    let browserPath = null;
    for (const path of possiblePaths) {
      if (fs.existsSync(path)) {
        browserPath = path;
        break;
      }
    }
    
    // Snap Chromium has permission issues, use Puppeteer's bundled browser instead
    // Don't set browserPathExecutable - let Puppeteer use bundled Chromium
    console.log('Using Puppeteer bundled Chromium (snap browsers have permission issues)');
    
    config.args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--disable-extensions',
    ];
  } else if (isWindows) {
    // On Windows, let venom-bot auto-detect Chrome/Edge or use puppeteer's bundled Chromium
    // Don't set browserPathExecutable - let it auto-detect
    config.args = [
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ];
  } else {
    // macOS or other
    config.args = [
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ];
  }

  return config;
}

// Auto-cleanup function - runs on startup
async function autoCleanup() {
  console.log('🧹 Auto-cleaning sessions and processes...');
  
  // Kill any Chrome processes that might be locking the session folder
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      console.log('   Killing Chrome processes...');
      execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
      execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore' });
      execSync('taskkill /F /IM chromedriver.exe /T 2>nul', { stdio: 'ignore' });
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait longer
      console.log('   ✅ Chrome processes killed');
    } catch (err) {
      // Ignore if no Chrome processes running
      console.log('   ℹ️ No Chrome processes to kill');
    }
  }
  
  // Clear all session folders - be more aggressive
  const sessionPath = `${tokenFolder}/${session}`;
  const wwebjsPath = `${tokenFolder}/wwebjs`;
  const tokensPath = tokenFolder;
  
  // Clear entire tokens folder to be sure - try multiple times
  if (fs.existsSync(tokensPath)) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`   Clearing tokens folder (attempt ${attempt}/3)...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Remove all subdirectories
        const items = fs.readdirSync(tokensPath);
        for (const item of items) {
          try {
            const itemPath = `${tokensPath}/${item}`;
            const stat = fs.statSync(itemPath);
            if (stat.isDirectory()) {
              // Try to remove with force
              fs.removeSync(itemPath, { force: true });
              console.log(`   ✅ Removed: ${item}`);
            } else if (stat.isFile()) {
              // Also remove files
              fs.unlinkSync(itemPath);
              console.log(`   ✅ Removed file: ${item}`);
            }
          } catch (e) {
            // Try again on next attempt
            if (attempt === 3) {
              console.log(`   ⚠️ Could not remove ${item}: ${e.message}`);
            }
          }
        }
        
        // Verify it's empty
        const remaining = fs.readdirSync(tokensPath);
        if (remaining.length === 0) {
          console.log('   ✅ All token folders cleared');
          break;
        } else if (attempt < 3) {
          console.log(`   ⚠️ Still ${remaining.length} items remaining, retrying...`);
        }
      } catch (err) {
        console.log(`   ⚠️ Attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }
  }
  
  // Clear old QR codes
  try {
    if (fs.existsSync(qrFolder)) {
      const qrFiles = fs.readdirSync(qrFolder);
      for (const file of qrFiles) {
        try {
          fs.unlinkSync(`${qrFolder}/${file}`);
        } catch (e) {
          // Ignore
        }
      }
      console.log('   ✅ Old QR codes cleared');
    }
  } catch (err) {
    // Ignore if folder doesn't exist or is empty
  }
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log('✅ Auto-cleanup complete - ready to start fresh\n');
  console.log('💡💡💡 CRITICAL STEPS BEFORE SCANNING QR CODE: 💡💡💡');
  console.log('   1. Open WhatsApp on your phone');
  console.log('   2. Go to Settings > Linked Devices');
  console.log('   3. Remove ALL devices (tap on each and select "Log out")');
  console.log('   4. Wait 10 seconds');
  console.log('   5. Close WhatsApp completely (swipe away from recent apps)');
  console.log('   6. Reopen WhatsApp');
  console.log('   7. Go back to Linked Devices and verify it\'s empty');
  console.log('   8. THEN scan the QR code\n');
}

// Initialize WhatsApp client
async function initClient() {
  if (venomClient) {
    try {
      await venomClient.logout();
    } catch (err) {
      console.log('Logout error (ignoring):', err?.message || err);
    }
    try {
      await venomClient.close();
    } catch (err) {
      console.log('Close error (ignoring):', err?.message || err);
    }
    venomClient = null;
    deviceConnected = false;
    currentQr = '';
    messageListenerActive = false;
  }
  
  // Auto-cleanup before starting
  await autoCleanup();

  // Status callback to track connection state
  // IMPORTANT: First param is statusSession (status), second is session (session name)
  // Use statusSession for status checks - eventName was wrongly using session name!
  function statusCallback(statusSession, sessionName) {
    const isConnected = statusSession === true || statusSession === 'isLogged' || statusSession === 'qrReadSuccess' || statusSession === 'chatsAvailable' || statusSession === 'connected';
    
    console.log(`WA STATUS -> statusSession=${statusSession} session=${sessionName} connected=${isConnected}`);
    
    // Handle connection events - use statusSession (the actual status), NOT session name
    if (statusSession === true || statusSession === 'isLogged' || statusSession === 'qrReadSuccess' || statusSession === 'chatsAvailable' || statusSession === 'connected') {
      console.log('✅ Connection detected! Starting message listener immediately...');
      deviceConnected = true;
      if (venomClient && !messageListenerActive) {
        console.log('🚀 Starting message listener NOW...');
        startListening(venomClient);
      }
    }
    
    // Handle authenticated/qrReadSuccess - venom sends these when QR is scanned
    if (statusSession === 'authenticated' || statusSession === 'qrReadSuccess' || statusSession === 'chatsAvailable') {
      console.log('🔐 Authenticated with WhatsApp');
      
      // Wait for FULL connection (chatsAvailable) - this ensures we're past "syncing"
      setTimeout(async () => {
        if (venomClient && !deviceConnected) {
          let retries = 0;
          const maxRetries = 15; // Wait up to 45 seconds (15 * 3s)
          
          const checkAndStart = async () => {
            try {
              const isReady = await verifyConnection();
              if (isReady) {
                deviceConnected = true;
                console.log('✅✅✅ Device FULLY connected! Starting message listener...');
                if (!messageListenerActive) {
                  startListening(venomClient);
                }
              } else {
                retries++;
                if (retries < maxRetries) {
                  console.log(`⏳ Still syncing... (attempt ${retries}/${maxRetries}), waiting 3 seconds...`);
                  setTimeout(checkAndStart, 3000);
                } else {
                  console.log('⚠️ Max retries reached. Starting listener anyway (may not work until syncing completes)...');
                  deviceConnected = true;
                  if (!messageListenerActive) {
                    startListening(venomClient);
                  }
                }
              }
            } catch (err) {
              console.log('⚠️ Verification error:', err.message);
              retries++;
              if (retries < maxRetries) {
                setTimeout(checkAndStart, 3000);
              } else {
                console.log('⚠️ Starting listener anyway after max retries...');
                deviceConnected = true;
                if (!messageListenerActive) {
                  startListening(venomClient);
                }
              }
            }
          };
          
          // Start checking after 5 seconds (give time for initial sync)
          setTimeout(checkAndStart, 5000);
        }
      }, 2000);
    }
    
    // Handle fully connected states
    if (isConnected && !deviceConnected && venomClient) {
      deviceConnected = true;
      console.log('✅ Device connected and ready');
      if (!messageListenerActive) {
        startListening(venomClient);
      }
    }
    
    // Handle disconnection states
    if (statusSession === false || statusSession === 'notLogged' || statusSession === 'closeBrowser' || statusSession === 'browserClose' || statusSession === 'desconnectedMobile') {
      deviceConnected = false;
      messageListenerActive = false;
      console.log('❌ Device disconnected');
      
      // If disconnected, suggest clearing session
      if (statusSession === 'desconnectedMobile' || statusSession === 'notLogged') {
        console.log('💡 If this keeps happening:');
        console.log('   1. Check WhatsApp on your phone - Settings > Linked Devices');
        console.log('   2. Remove any existing "session" device');
        console.log('   3. Delete the tokens folder and restart the bot');
      }
    }
    
    // Handle "disconnected by cell phone" specifically (venom sends desconnectedMobile)
    if (statusSession === 'desconnectedMobile') {
      deviceConnected = false;
      messageListenerActive = false;
      console.log('⚠️ Disconnected by phone - another session may be active');
      console.log('💡 Solution: Remove "session" from Linked Devices in WhatsApp, then restart');
    }
    
    // Handle errors
    if (statusSession === 'qrReadError' || statusSession === 'qrReadFail' || statusSession === 'autocloseCalled') {
      deviceConnected = false;
      messageListenerActive = false;
      console.log('⚠️ Connection error or closed');
    }
  }

  const browserConfig = getBrowserConfig();
  
  // Log that we're about to create client
  console.log('🚀 Creating WhatsApp client...');
  console.log('   Session:', session);
  console.log('   QR Handler will be called when QR is generated');
  
  try {
    // Try different callback formats for venom-bot 5.x
    const qrCallback = (qr, asciiQR, attempts, urlCode) => {
      console.log('📱📱📱 QR CALLBACK TRIGGERED! 📱📱📱');
      console.log('   QR type:', typeof qr);
      console.log('   QR value:', qr ? (typeof qr === 'string' ? qr.substring(0, 50) + '...' : String(qr).substring(0, 50)) : 'null/undefined');
      console.log('   asciiQR type:', typeof asciiQR);
      console.log('   attempts:', attempts);
      console.log('   urlCode:', urlCode);
      
      // Handle different callback formats
      if (typeof qr === 'string') {
        qrHandler(qr, asciiQR);
      } else if (qr && qr.base64) {
        qrHandler(qr.base64, asciiQR);
      } else if (qr && qr.qr) {
        qrHandler(qr.qr, asciiQR);
      } else if (asciiQR) {
        // If only asciiQR is provided, we can't use it for web display
        // but we can log it
        console.log('⚠️ Only ASCII QR provided, cannot display on web');
        console.log('💡 Scan the ASCII QR code from terminal or wait for manual extraction');
      } else {
        console.log('⚠️ Unexpected QR format:', qr);
        // Try to call handler anyway
        qrHandler(qr, asciiQR);
      }
    };
    
    venomClient = await venom.create(
      {
        session,
        multidevice: true,
        folderNameToken: tokenFolder,
        ...browserConfig,
        // Force QR generation by disabling session restore
        disableWelcome: true,
        // Add these to prevent connection issues
        updatesLog: false,
        autoClose: 0,
        // Use a fresh session each time
        refreshQR: 15000, // Refresh QR every 15 seconds
      },
      qrCallback,  // QR callback
      statusCallback  // Status callback
    );
    
    // CRITICAL: Register onMessage IMMEDIATELY when client is created
    // Venom-bot 5.x requires onMessage to be registered early - before or right when connected
    // The basic venom example does: venom.create().then(client => client.onMessage(...))
    console.log('🚀 Client created - registering onMessage handler NOW (venom-bot needs early registration)');
    startListening(venomClient);
    
  } catch (err) {
    const errorMsg = err?.message || err?.toString() || 'Unknown error';
    console.error('❌ Error creating WhatsApp client:', errorMsg);
    console.error('Full error:', err);
    
    // If disconnected by phone, suggest clearing session
    if (errorMsg.includes('disconnected') || errorMsg.includes('cell phone')) {
      console.log('💡 Tip: You may need to:');
      console.log('   1. Go to WhatsApp on your phone');
      console.log('   2. Settings > Linked Devices');
      console.log('   3. Remove any existing "session" device');
      console.log('   4. Or delete the tokens folder and restart');
    }
    
    // Clean up on error
    venomClient = null;
    deviceConnected = false;
    throw err;
  }

  // Check if already connected (for existing sessions)
  try {
    const isReady = await verifyConnection();
    if (isReady) {
      deviceConnected = true;
      console.log('✅ Device already logged in and connected');
      if (!messageListenerActive) {
        startListening(venomClient);
      }
    } else {
      console.log('⏳ Waiting for QR scan or connection...');
      console.log('💡 If QR code doesn\'t appear, try:');
      console.log('   1. Delete tokens/session folder');
      console.log('   2. Remove "session" from Linked Devices on your phone');
      console.log('   3. Restart the bot');
      
      // Try to manually get QR code if callback didn't fire
      // Check multiple times as QR might appear later
      const checkQR = async (attempt = 1) => {
        if (!currentQr && venomClient && attempt <= 15) {
          console.log(`🔍 Checking for QR code (attempt ${attempt}/15)...`);
          try {
            // Try different ways to get QR from client object
            if (venomClient.qrCode) {
              console.log('✅ Found QR code in client.qrCode');
              qrHandler(venomClient.qrCode);
              return;
            }
            
            // Also check if QR is in other client properties
            if (venomClient.qr && venomClient.qr !== '') {
              console.log('✅ Found QR code in client.qr');
              qrHandler(venomClient.qr);
              return;
            }
            
            // Try accessing page through different paths
            let page = null;
            try {
              page = venomClient.page || 
                     venomClient._page || 
                     (venomClient.client && venomClient.client.page) ||
                     (venomClient.browser && venomClient.browser.pages && venomClient.browser.pages()[0]);
            } catch (e) {
              // Ignore
            }
            
            if (page) {
              try {
                console.log('✅ Found page object, looking for QR element...');
                
                // Wait a bit for page to fully load
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Try multiple approaches to find QR code
                try {
                  // Approach 1: Try canvas elements
                  const canvases = await page.$$('canvas');
                  console.log(`   Found ${canvases.length} canvas element(s)`);
                  
                  for (let i = 0; i < canvases.length; i++) {
                    try {
                      const canvas = canvases[i];
                      const canvasInfo = await page.evaluate((el) => {
                        if (!el) return null;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return {
                          width: rect.width,
                          height: rect.height,
                          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
                        };
                      }, canvas);
                      
                      if (canvasInfo && canvasInfo.visible) {
                        console.log(`   Canvas ${i}: ${canvasInfo.width}x${canvasInfo.height}`);
                        
                        // QR codes are usually square and at least 200x200
                        if (canvasInfo.width > 200 && canvasInfo.height > 200) {
                          console.log(`✅ Found likely QR canvas (${canvasInfo.width}x${canvasInfo.height}), extracting...`);
                          const qrData = await canvas.screenshot({ encoding: 'base64' });
                          if (qrData && qrData.length > 1000) {
                            console.log(`✅ QR data extracted successfully (${qrData.length} chars)`);
                            qrHandler(`data:image/png;base64,${qrData}`);
                            return;
                          }
                        }
                      }
                    } catch (canvasErr) {
                      // Continue to next canvas
                    }
                  }
                  
                  // Approach 2: Try to find QR by taking screenshot of the QR area
                  // WhatsApp Web QR is usually in a specific div
                  const qrArea = await page.evaluate(() => {
                    // Look for elements containing "QR" or "Scan"
                    const elements = document.querySelectorAll('div, canvas, img');
                    for (const el of elements) {
                      const text = el.textContent || el.alt || el.getAttribute('aria-label') || '';
                      const rect = el.getBoundingClientRect();
                      if ((text.toLowerCase().includes('qr') || text.toLowerCase().includes('scan')) && 
                          rect.width > 200 && rect.height > 200) {
                        return { found: true, width: rect.width, height: rect.height };
                      }
                    }
                    // Or look for large square elements (QR codes are usually square)
                    for (const el of elements) {
                      const rect = el.getBoundingClientRect();
                      const ratio = rect.width / rect.height;
                      if (rect.width > 200 && rect.height > 200 && ratio > 0.8 && ratio < 1.2) {
                        // Square-ish element, might be QR
                        return { found: true, width: rect.width, height: rect.height };
                      }
                    }
                    return { found: false };
                  });
                  
                  if (qrArea.found) {
                    console.log(`   Found QR area (${qrArea.width}x${qrArea.height}), trying to screenshot...`);
                    // Take screenshot of the visible page area where QR might be
                    const screenshot = await page.screenshot({ 
                      encoding: 'base64',
                      clip: { x: 0, y: 0, width: 800, height: 800 } // Top-left area where QR usually is
                    });
                    if (screenshot && screenshot.length > 1000) {
                      console.log(`✅ Page screenshot captured (${screenshot.length} chars)`);
                      qrHandler(`data:image/png;base64,${screenshot}`);
                      return;
                    }
                  }
                  
                  // Approach 3: Just take a screenshot of the visible page
                  console.log('   Taking full page screenshot as fallback...');
                  const fullScreenshot = await page.screenshot({ encoding: 'base64' });
                  if (fullScreenshot && fullScreenshot.length > 10000) {
                    console.log(`✅ Full page screenshot captured (${fullScreenshot.length} chars)`);
                    qrHandler(`data:image/png;base64,${fullScreenshot}`);
                    return;
                  }
                  
                  console.log('   No QR element found with any method, will retry...');
                } catch (waitErr) {
                  console.log('   Error finding QR:', waitErr.message);
                }
              } catch (pageErr) {
                console.log('   Page access error:', pageErr.message);
              }
            } else {
              console.log('   Page object not accessible yet');
            }
            
            // Schedule next check
            if (attempt < 10) {
              setTimeout(() => checkQR(attempt + 1), 8000); // Check every 8 seconds
            } else {
              console.log('⚠️ QR code not found after 10 attempts');
              console.log('💡 Solutions:');
              console.log('   1. Check terminal logs for ASCII QR codes (look for █ characters)');
              console.log('   2. Clear tokens/session folder completely');
              console.log('   3. Remove "session" device from WhatsApp Linked Devices');
              console.log('   4. Restart the bot');
            }
          } catch (err) {
            console.log('⚠️ Could not retrieve QR manually:', err.message);
            if (attempt < 10) {
              setTimeout(() => checkQR(attempt + 1), 8000);
            }
          }
        }
      };
      
      // Start checking after 3 seconds (give time for page to load)
      console.log('⏳ Will start checking for QR code in 3 seconds...');
      setTimeout(() => {
        console.log('🔍 Starting QR code check now...');
        checkQR(1);
      }, 3000);
    }
  } catch (err) {
    console.log('⏳ Waiting for connection...', err.message);
  }
}

// Handle QR display
async function qrHandler(base64Qr, asciiQR) {
  console.log('📱 QR Handler called!');
  console.log('   base64Qr type:', typeof base64Qr);
  console.log('   asciiQR type:', typeof asciiQR);
  
  // Handle different callback formats from venom-bot
  let qrData = base64Qr;
  
  // If first param is ascii, second might be base64
  if (typeof base64Qr === 'string' && base64Qr.includes('█') && asciiQR) {
    qrData = asciiQR;
  }
  
  // Ensure the QR is in the correct format for web display
  if (qrData && typeof qrData === 'string') {
    // If it's already a data URI, use it directly
    if (qrData.startsWith('data:image')) {
      currentQr = qrData;
    } else if (qrData.startsWith('data:image/png')) {
      currentQr = qrData;
    } else {
      // Otherwise, format it as a data URI
      currentQr = `data:image/png;base64,${qrData}`;
    }
    
    // Save to file
    try {
      const img = currentQr.includes(';base64,') 
        ? currentQr.split(';base64,').pop() 
        : qrData;
      fs.writeFileSync(`${qrFolder}/last_qr.png`, img, { encoding: 'base64' });
      console.log('✅ QR code saved to file');
    } catch (err) {
      console.log('⚠️ Could not save QR to file:', err.message);
    }
    
    // Show localhost for local access, but also show network IP if available
    const displayUrl = process.platform === 'win32' ? 'localhost' : (localIp !== 'localhost' ? localIp : 'localhost');
    console.log(`🖼️ QR updated: http://${displayUrl}:${PORT}/qr`);
    if (localIp !== 'localhost' && process.platform !== 'win32') {
      console.log(`   Also accessible at: http://${localIp}:${PORT}/qr (from other devices)`);
    }
    console.log(`✅ QR code is now available on web interface (length: ${currentQr.length})`);
  } else {
    console.log('⚠️ QR code received but format is invalid. base64Qr:', typeof base64Qr, 'asciiQR:', typeof asciiQR);
  }
}

// Process a single message - extracted for reuse
async function processMessage(client, message) {
  const sender = message.from;
  const text = (message.body || '').trim();
  
  // Ignore group messages
  if (sender.includes('@g.us')) {
    return;
  }

  // Ignore status broadcasts
  if (sender === 'status@broadcast') {
    return;
  }

  if (!client._convos[sender]) {
    console.log(`[New] Starting conversation with ${sender}`);
    client._convos[sender] = { step: 0 };
  }

  let state = client._convos[sender];

  try {
    switch (state.step) {
      case 0:
        console.log(`📤 Sending welcome message to ${sender}...`);
        await client.sendText(sender, 'Hello 👋\nThank you for contacting Giga Advisory Group.\nWe help individuals with USA visa and immigration services.\nTo assist you better, please answer a few quick questions.\nType START to begin.');
        state.step = 1;
        break;

      case 1:
        if (text.toUpperCase().trim() !== 'START') {
          await client.sendText(sender, 'Please type START to begin.');
          return;
        }
        console.log(`📤 Sending visa type question to ${sender}...`);
        await client.sendText(sender, 'What type of visa are you interested in?\n• Work Visa\n• Study Visa\n• Visit Visa\n• Immigration / PR\n• Business / Investor Visa');
        state.step = 2;
        break;

      case 2:
        state.visaType = text;
        await client.sendText(sender, 'What is your age?\n• 18 – 24\n• 25 – 34\n• 35 – 44\n• 45+');
        state.step = 3;
        break;

      case 3:
        state.age = text;
        await client.sendText(sender, "What is your highest education level?\n• High School\n• Diploma\n• Bachelor's Degree\n• Master's Degree\n• Other");
        state.step = 4;
        break;

      case 4:
        state.education = text;
        await client.sendText(sender, 'How many years of work experience do you have?\n• No experience\n• 1 – 2 years\n• 3 – 5 years\n• 5+ years');
        state.step = 5;
        break;

      case 5:
        state.workExperience = text;
        await client.sendText(sender, 'Have you taken an English test like IELTS or PTE?\n• Yes\n• No\n• Planning to take');
        state.step = 6;
        break;

      case 6:
        state.englishTest = text;
        await client.sendText(sender, 'What is your current occupation / profession?\n• IT / Software\n• Engineer\n• Healthcare / Medical\n• Business / Finance\n• Sales / Marketing\n• Skilled Trade (Electrician, Plumber, etc.)\n• Student\n• Other');
        state.step = 7;
        break;

      case 7:
        state.occupation = text;
        await client.sendText(sender, 'Great! One of our immigration advisors will review your details.\nPlease share your Full Name.');
        state.step = 8;
        break;

      case 8:
        state.fullName = text;
        await client.sendText(sender, 'Please share your Email Address.');
        state.step = 9;
        break;

      case 9:
        state.email = text;
        await client.sendText(sender, 'Thank you for submitting your information ✅\nOur immigration consultants will review your details and contact you within 24 hours.\nPlease keep an eye on the email address you provided, as our team may also reach out via email with further details.\nIf you have any documents ready (CV, IELTS result, passport copy), you may share them here to speed up your assessment.\nHave a great day!');
        state.step = 10;
        break;

      case 10:
        if (message.isMedia && (message.type === 'image' || message.type === 'document')) {
          console.log(`📥 Receiving document from ${sender}...`);
          try {
            const media = await client.decryptFile(message);
            const safeSender = (sender || '').replace(/@c\.us|@s\.whatsapp\.net/g, '');
            const ext = message.type === 'image' ? '.jpg' : '.pdf';
            const docPath = `./receipts/${safeSender}_doc_${Date.now()}${ext}`;
            fs.writeFileSync(docPath, media);
            await client.sendText(sender, 'Thanks, we\'ve received your document.');
          } catch (mediaErr) {
            console.error(`❌ Error processing document:`, mediaErr);
            await client.sendText(sender, '⚠️ Error processing document. Please try again.');
          }
        } else {
          await client.sendText(sender, 'If you have any documents ready (CV, IELTS result, passport copy), you may share them here to speed up your assessment.');
        }
        break;

      default:
        client._convos[sender] = { step: 0 };
        await client.sendText(sender, "Something went wrong. Let's start over.");
        break;
    }

    // Save state only if it hasn't been cleared
    if (state) {
      client._convos[sender] = state;
    }
  } catch (err) {
    console.error(`❌ Error processing message from ${sender}:`, err);
    console.error(`❌ Error stack:`, err.stack);
    try {
      await client.sendText(sender, '⚠️ Internal error. Please try again.');
    } catch (sendErr) {
      console.error(`❌ Failed to send error message:`, sendErr);
    }
  }
}

// Message logic
async function startListening(client) {
  if (messageListenerActive) {
    console.log('⚠️ Message listener already active, skipping...');
    return;
  }
  
  messageListenerActive = true;
  client._convos = client._convos || {};
  
  console.log('👂👂👂 MESSAGE LISTENER STARTED! 👂👂👂');
  console.log('   Client type:', typeof client);
  console.log('   Client has onMessage:', typeof client.onMessage);
  
  // Verify client is ready before setting up listener
  console.log('   Verifying client methods...');
  console.log('   - client.sendText:', typeof client.sendText);
  console.log('   - client.onMessage:', typeof client.onMessage);
  console.log('   - client.isLoggedIn:', typeof client.isLoggedIn);
  
  // Test if client is logged in
  try {
    const isLoggedIn = await client.isLoggedIn();
    console.log(`   ✅ Client isLoggedIn check: ${isLoggedIn}`);
    if (!isLoggedIn) {
      console.log(`   ⚠️ WARNING: Client reports not logged in! Messages may not work.`);
    }
  } catch (err) {
    console.log(`   ⚠️ Could not check login status: ${err.message}`);
  }

  // Set up onMessage listener with extensive logging
  console.log('   Setting up onMessage callback...');
  client.onMessage(async message => {
    try {
      console.log(`\n🔔🔔🔔 MESSAGE RECEIVED! 🔔🔔🔔`);
      console.log(`   From: ${message.from}`);
      console.log(`   Body: ${(message.body || '').substring(0, 100)}`);
      console.log(`   Type: ${message.type || 'text'}`);
      console.log(`   HasMedia: ${message.isMedia || false}`);
      console.log(`   FromMe: ${message.fromMe || false}`);
      console.log(`   Message timestamp: ${message.timestamp || 'N/A'}`);
      
      // Check if message is from ourselves
      if (message.fromMe) {
        console.log(`   [Ignored] Message from bot itself`);
        return;
      }
      
      // Check if it's a group message
      if (message.from && message.from.includes('@g.us')) {
        console.log(`   [Ignored] Group message`);
        return;
      }
      
      // Check if it's a status broadcast
      if (message.from === 'status@broadcast') {
        console.log(`   [Ignored] Status broadcast`);
        return;
      }
      
      console.log(`   ✅ Message passed filters, processing...`);
      console.log(`   Processing message from ${message.from}, text length: ${(message.body || '').trim().length}`);
      
      await processMessage(client, message);
      console.log(`   ✅ Message processing completed`);
    } catch (err) {
      console.error(`   ❌ Error in onMessage callback:`, err);
      console.error(`   Error stack:`, err.stack);
    }
  });
  console.log('   ✅ onMessage callback registered');
  
  // Also start polling as backup
  console.log('🔄 Starting message polling as backup mechanism...');
  startMessagePolling(client);
}

// Web routes
app.use(express.json());

// Serve QR code image file
app.get('/qr-image', (req, res) => {
  const qrPath = `${qrFolder}/last_qr.png`;
  if (fs.existsSync(qrPath)) {
    res.sendFile(qrPath, { root: process.cwd() });
  } else {
    res.status(404).send('QR code not found');
  }
});

app.get('/qr', (req, res) => {
  // Debug: log current state
  console.log(`[QR Route] currentQr exists: ${!!currentQr}, deviceConnected: ${deviceConnected}`);
  
  // Check for saved QR file
  const qrPath = `${qrFolder}/last_qr.png`;
  const qrFileExists = fs.existsSync(qrPath);
  console.log(`[QR Route] QR file exists: ${qrFileExists} at ${qrPath}`);
  
  const buttons = deviceConnected
    ? `<button onclick="handleAction('/logout')">Logout</button>
       <button onclick="handleAction('/restart')">New QR</button>`
    : `<button onclick="handleAction('/restart')">Generate QR</button>`;

  // Try to get QR from currentQr variable or from saved file
  let imgTag = '';
  if (currentQr) {
    imgTag = `<img src="${currentQr}" style="max-width:400px; border:2px solid #ddd; padding:10px;" alt="QR Code" />`;
    console.log('[QR Route] Using currentQr variable');
  } else if (qrFileExists) {
    // Fallback: try to load from saved file
    imgTag = `<img src="/qr-image?t=${Date.now()}" style="max-width:400px; border:2px solid #ddd; padding:10px;" alt="QR Code" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" /><p style="display:none; color:#666;">Image failed to load. Check server logs.</p>`;
    console.log('[QR Route] Using saved QR image file');
  } else {
    imgTag = '<p style="color:#666;">No QR yet... Waiting for QR code generation.</p><p style="color:#999; font-size:12px;">The bot is running. QR code will appear here when generated. Check terminal logs for ASCII QR code.</p>';
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Giga Advisory Group</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
        button { padding: 10px 20px; margin: 5px; font-size: 16px; cursor: pointer; background: #25D366; color: white; border: none; border-radius: 5px; }
        button:hover { background: #128C7E; }
        button:disabled { background: #ccc; cursor: not-allowed; }
        #status { margin-top: 10px; color: #666; }
      </style>
    </head>
    <body>
      <h2>Giga Advisory Group</h2>
      ${imgTag}
      <div style="margin-top:1em">${buttons}</div>
      <div id="status"></div>
      <p style="margin-top:20px; color:#999; font-size:12px;">Page auto-refreshes every 5 seconds</p>
      <script>
        async function handleAction(endpoint) {
          const status = document.getElementById('status');
          const buttons = document.querySelectorAll('button');
          buttons.forEach(b => b.disabled = true);
          status.textContent = 'Processing...';
          
          try {
            const response = await fetch(endpoint, { method: 'POST' });
            const text = await response.text();
            status.textContent = text;
            setTimeout(() => {
              window.location.reload();
            }, 1500);
          } catch (error) {
            status.textContent = 'Error: ' + error.message;
            buttons.forEach(b => b.disabled = false);
          }
        }
      </script>
    </body>
    </html>`);
});

app.post('/logout', async (req, res) => {
  if (venomClient) {
    try {
      await venomClient.logout();
      await venomClient.close();
      venomClient = null;
      deviceConnected = false;
      currentQr = '';
      messageListenerActive = false;
      res.send('✔️ Logged out and session closed');
    } catch (err) {
      console.error('Logout error:', err);
      res.status(500).send('Logout error');
    }
  } else {
    res.status(400).send('No active session');
  }
});

app.post('/restart', async (req, res) => {
  try {
    // Close current client if exists (this closes the browser)
    if (venomClient) {
      try {
        await venomClient.logout();
        await venomClient.close();
        // Wait a bit for browser to fully close
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.log('Error closing client:', err.message);
      }
      venomClient = null;
    }
    
    deviceConnected = false;
    currentQr = '';
    messageListenerActive = false;
    
    // Try to clear session tokens, but don't fail if it doesn't work
    const sessionPath = `${tokenFolder}/${session}`;
    if (fs.existsSync(sessionPath)) {
      try {
        // Try to remove, but handle permission errors gracefully
        fs.removeSync(sessionPath);
        console.log('✅ Cleared old session tokens');
      } catch (err) {
        console.log('⚠️ Could not delete session folder (may be locked):', err.message);
        console.log('💡 This is okay - will try to use existing session or generate new QR');
        // Don't fail - just continue without deleting
      }
    }
    
    // Initialize new client (will generate new QR)
    await initClient();
    res.send('🔄 Generating new QR code... Please wait a few seconds.');
  } catch (err) {
    console.error('Restart error:', err);
    const errorMsg = err?.message || err?.toString() || 'Unknown error';
    console.error('Full error details:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    res.status(500).send('Failed to restart: ' + errorMsg);
  }
});

app.post('/clear-session', async (req, res) => {
  try {
    // Close current client if exists (this closes the browser)
    if (venomClient) {
      try {
        await venomClient.logout();
        await venomClient.close();
        // Wait for browser to fully close
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.log('Error closing client:', err.message);
      }
      venomClient = null;
    }
    
    deviceConnected = false;
    currentQr = '';
    messageListenerActive = false;
    
    // Try to clear session tokens
    const sessionPath = `${tokenFolder}/${session}`;
    if (fs.existsSync(sessionPath)) {
      try {
        fs.removeSync(sessionPath);
        console.log('✅ Session tokens cleared');
        res.send('✔️ Session cleared. Restart the bot to generate a new QR code.');
      } catch (err) {
        console.log('⚠️ Could not delete session folder:', err.message);
        res.send('⚠️ Session closed but folder may be locked. Try closing Chrome/Edge manually, then restart.');
      }
    } else {
      res.send('✔️ No session found to clear.');
    }
  } catch (err) {
    console.error('Clear session error:', err);
    res.status(500).send('Failed to clear session: ' + err.message);
  }
});

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION - Preventing crash:', error);
  console.error('Stack:', error.stack);
  // Don't exit - keep the server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION - Preventing crash:', reason);
  if (reason instanceof Error) {
    console.error('Stack:', reason.stack);
  }
  // Don't exit - keep the server running
});

// Start app
app.listen(PORT, '0.0.0.0', async () => {
  // Display localhost for browser access (0.0.0.0 is just for binding)
  const displayUrl = process.platform === 'win32' ? 'localhost' : (localIp !== 'localhost' ? localIp : 'localhost');
  console.log(`🌐 Server running at: http://${displayUrl}:${PORT}/qr`);
  if (localIp !== 'localhost' && process.platform !== 'win32') {
    console.log(`   Also accessible at: http://${localIp}:${PORT}/qr (from other devices)`);
  }
  console.log('\n🚀 Starting WhatsApp bot with auto-cleanup...\n');
  
  // Wrap initClient in try-catch to prevent crashes
  try {
    await initClient();
  } catch (err) {
    console.error('❌ Error initializing client:', err);
    console.error('Stack:', err.stack);
    console.log('💡 Server will keep running. Check logs and try /restart endpoint.');
    console.log('💡 Or restart the bot - it will auto-cleanup on next start.');
  }
});
