require('dotenv').config(); // For local .env loading

// Polyfill for EventTarget (required for Node.js local dev - keep if testing locally)
if (typeof globalThis !== 'undefined') {
  const { EventTarget, Event } = require('event-target-polyfill');
  globalThis.EventTarget = EventTarget;
  globalThis.Event = Event;
}

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!BOT_TOKEN || !WEBHOOK_URL) {
  throw new Error('Missing required env vars: BOT_TOKEN, WEBHOOK_URL');
}

const app = express();
app.use(express.json()); // Parse JSON for POST bodies

// Initialize bot (polling initially, switch to webhook after set)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// File-based storage for chats (use /tmp for Vercel writability)
const CHATS_FILE = '/tmp/chats.json';  // Writable dir on Vercel/local

// Load chats from file (or default to empty array)
let chatIds = [];
if (fs.existsSync(CHATS_FILE)) {
  try {
    chatIds = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'));
    console.log(`Loaded ${chatIds.length} chats from file`);
  } catch (err) {
    console.error('Error loading chats.json:', err.message);
    chatIds = [];
  }
} else {
  console.log('No chats.json found—starting empty');
}

// Helper: Save chats to file (graceful—no throw)
function saveChats() {
  try {
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chatIds, null, 2));
    console.log('Chats saved to file');
  } catch (err) {
    console.error('Error saving chats (non-fatal):', err.message);
    // Don't throw—log and continue
  }
}

// Helper: Add chat (manual or from events)
function addChat(chatId) {
  const chatIdStr = chatId.toString();
  if (!chatIds.includes(chatIdStr)) {
    chatIds.push(chatIdStr);
    saveChats();
    console.log(`Added chat ${chatId}`);
  }
}

// Helper: Get all chats
function getAllChatIds() {
  return chatIds;
}

// Helper: Remove invalid chat
function removeChat(chatIdStr) {
  chatIds = chatIds.filter(id => id !== chatIdStr);
  saveChats();
  console.log(`Removed chat ${chatIdStr}`);
}

// Bot event: New chat members (auto-register when added to group)
bot.on('new_chat_members', async (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'private') {
    addChat(chatId);
  }
  // Welcome message
  try {
    await bot.sendMessage(chatId, 'Hi! I\'m your Jira Daily Bot. I\'ll send task reports daily. Use /start for help or /report for manual.');
  } catch (err) {
    console.error('Welcome send error:', err.message);
  }
});

// Bot event: /start command (register private chats)
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  addChat(chatId);
  bot.sendMessage(chatId, 'Bot started! Add me to groups for daily Jira reports. /report for manual trigger.');
});

// Optional: /report command (placeholder for manual)
bot.onText(/\/report/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Manual report ready—daily auto-send at scheduled time!');
});

// API: POST /send-report (from n8n: { "message": "formatted list" })
app.post('/send-report', async (req, res) => {
  console.log('POST /send-report received:', req.body, 'Method:', req.method, 'Path:', req.path);
  
  const { message } = req.body;
  if (!message) {
    console.log('Missing message in body');
    return res.status(400).json({ error: 'No message provided' });
  }

  try {
    console.log('Starting broadcast—current chats:', chatIds.length);  // Debug log
    const chatIdsArray = getAllChatIds();
    if (chatIdsArray.length === 0) {
      console.log('No registered chats');
      return res.json({ sentTo: 0, totalChats: 0 });
    }

    let sentCount = 0;
    for (const chatIdStr of chatIdsArray) {
      const chatId = parseInt(chatIdStr);
      console.log(`Attempting send to ${chatId}`);  // Debug per chat
      try {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        sentCount++;
        console.log(`Sent to ${chatId}`);
      } catch (err) {
        console.error(`Failed to send to ${chatId}: ${err.message}`);
        // Auto-remove invalid chats (e.g., bot kicked)
        if (err.message.includes('chat not found') || err.message.includes('blocked by user')) {
          removeChat(chatIdStr);
        }
      }
    }
    console.log(`Broadcast complete: ${sentCount} sent`);  // Debug end
    res.json({ sentTo: sentCount, totalChats: chatIdsArray.length });
  } catch (err) {
    console.error('Broadcast error (full stack):', err.message, err.stack);  // Detailed log
    res.status(500).json({ error: 'Failed to send reports' });
  }
});

// GET /set-webhook (call once after deploy to switch from polling)
app.get('/set-webhook', async (req, res) => {
  try {
    await bot.setWebHook(WEBHOOK_URL);
    bot.stopPolling(); // Stop polling after webhook set
    console.log('Webhook set to:', WEBHOOK_URL);
    res.send('Webhook set successfully! Bot now listens via webhook.');
  } catch (err) {
    console.error('Webhook set error:', err);
    res.status(500).send(`Failed to set webhook: ${err.message}`);
  }
});

// GET / (health check)
app.get('/', (req, res) => {
  res.send('Bereke Vulnerability Bot is alive! Visit /set-webhook once to activate.');
});

// Catch-all for debugging (log unhandled routes)
app.use((req, res) => {
  console.log(`Unhandled request: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Route not found' });
});

// Start local server for dev (skip in Vercel/production)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Local server running on http://localhost:${PORT}`);
    console.log('Bot polling active—add to a group to test events.');
  });
}

// Serverless export for Vercel
module.exports = app;