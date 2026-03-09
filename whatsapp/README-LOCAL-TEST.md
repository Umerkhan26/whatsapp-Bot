# Local Testing Guide

## Setup Steps

1. **Install/Update Dependencies:**
   ```powershell
   cd "D:\other laptop data\other projects\whatsappbot\new code\whatsapp\whatsapp"
   npm install
   ```

2. **Clear Old Sessions:**
   ```powershell
   # Remove old session folder
   Remove-Item -Recurse -Force tokens\session -ErrorAction SilentlyContinue
   Remove-Item -Recurse -Force qrcodes\* -ErrorAction SilentlyContinue
   ```

3. **Check .env file:**
   Make sure you have:
   ```
   PORT=3000
   SESSION_NAME=session
   ```

4. **Run the Bot:**
   ```powershell
   npm start
   # or
   node index.js
   ```

## What to Look For

1. **QR Code Generation:**
   - You should see "📱 QR CALLBACK TRIGGERED!" in console
   - QR code should appear at: http://localhost:3000/qr
   - ASCII QR codes will appear in terminal (look for █ characters)

2. **Connection:**
   - Scan QR code with WhatsApp
   - You should see "✅ Device connected and ready"
   - You should see "👂 Message listener started"

3. **Test Messages:**
   - Send a message to the bot
   - You should see "🔔🔔🔔 MESSAGE RECEIVED!"
   - Bot should reply with welcome message

## Troubleshooting

- **If QR doesn't appear:** Check terminal for ASCII QR codes
- **If stuck in "waiting for introduction":** Clear tokens/session folder and restart
- **If messages don't work:** Check logs for "🔔" messages

## After Local Testing Works

Once it works locally, copy the working `index.js` to your server!
