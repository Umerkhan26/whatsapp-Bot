# WhatsApp Bot with Baileys

This is a new implementation using **Baileys** - a more reliable WhatsApp library that doesn't use browser automation.

## Why Baileys?

- ✅ **More reliable** - No browser automation issues
- ✅ **Faster** - Direct protocol implementation
- ✅ **Better connection handling** - No "syncing" stuck states
- ✅ **Actively maintained** - Regular updates
- ✅ **No Chrome/Puppeteer** - Lighter weight

## Installation

1. Install dependencies:
```bash
npm install
```

2. Run the bot:
```bash
node index-baileys.js
```

Or update package.json to use it as default:
```json
"scripts": {
  "start": "node index-baileys.js"
}
```

## How it works

1. The bot will generate a QR code
2. Scan it with your phone
3. Connection is established directly (no browser needed)
4. Messages are received and processed immediately

## Features

- ✅ Automatic QR code generation
- ✅ Web interface at http://localhost:3000/qr
- ✅ Message handling with conversation flow
- ✅ Image receipt upload support
- ✅ Auto-reconnection on disconnect

## Migration from venom-bot

The conversation flow is identical - just more reliable!
