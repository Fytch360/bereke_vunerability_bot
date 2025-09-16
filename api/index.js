require('dotenv').config(); // For local .env loading

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { createClient } = require('@vercel/kv');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;

if (!BOT_TOKEN || !WEBHOOK_URL || !KV_REST_API_URL || !KV_REST_API_TOKEN) {
  throw new Error('Missing required env vars: BOT_TOKEN, WEBHOOK_URL, KV_REST_API_URL, KV_REST_API_TOKEN');
}

const app = express();
app.use(express.json()); // Parse JSON for POST bodies

// Initialize bot (polling initially, switch to webhook after set)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Initialize KV client with standard vars
const kv = createClient({
  url: KV_REST_API_URL,
  token: KV_REST_API_TOKEN,
});

// Helper: Store individual chat details
async function storeChatId(chatId, chatType) {
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'private') {
    const key = `chat:${chatId}`;
    await kv.set(key, { chatId, type: chatType, addedAt: new Date().toISOString() });
    console.log(`Stored chat ${chatId} (${chatType})`);
  }
}

// Helper: Get all stored chat IDs (comma-separated string for simplicity)
async function getAllChatIds() {
  const allChatsKey = 'all_chats';
  const allIdsStr = await kv.get(allChatsKey) || '';
  return allIdsStr ? allIdsStr.split(',') : [];
}

// Helper: Add chat to all_chats list
async function addToAllChats(chatId) {
  const allChatsKey = 'all_chats';
  let allIdsStr = await kv.get(allChatsKey) || '';
  const chatIdStr = chatId.toString();
  if (!allIdsStr.includes(chatIdStr)) {
    allIdsStr += (allIdsStr ? ',' : '') + chatIdStr;
    await kv.set(allChatsKey, allIdsStr);
  }
}

// Helper: Remove invalid chat from all_chats
async function removeFromAllChats(chatIdStr) {
  const allChatsKey = 'all_chats';
  let allIdsStr = await kv.get(allChatsKey) || '';
  allIdsStr = allIdsStr.replace(new RegExp(`,?${chatIdStr}(,|$)`, 'g'), '');
  await kv.set(allChatsKey, allIdsStr || '');
}

// Bot event: New chat members (auto-register when added to group)
bot.on('new_chat_members', async (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  await storeChatId(chatId, chatType);
  await addToAllChats(chatId);
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
  const chatType = msg.chat.type;
  await storeChatId(chatId, chatType);
  await addToAllChats(chatId);
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
    const chatIds = await getAllChatIds();
    if (chatIds.length === 0) {
      console.log('No registered chats');
      return res.json({ sentTo: 0, totalChats: 0 });
    }

    let sentCount = 0;
    for (const chatIdStr of chatIds) {
      const chatId = parseInt(chatIdStr);
      try {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        sentCount++;
        console.log(`Sent to ${chatId}`);
      } catch (err) {
        console.error(`Failed to send to ${chatId}: ${err.message}`);
        // Auto-remove invalid chats (e.g., bot kicked)
        if (err.message.includes('chat not found') || err.message.includes('blocked by user')) {
          await removeFromAllChats(chatIdStr);
        }
      }
    }
    res.json({ sentTo: sentCount, totalChats: chatIds.length });
  } catch (err) {
    console.error('Broadcast error:', err);
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

// Serverless export for Vercel
module.exports = app;