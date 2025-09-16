const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { createClient } = require('@vercel/kv');

const app = express();
app.use(express.json()); // Parse JSON bodies for n8n POST

// Environment variables (set in Vercel)
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = 'https://bereke-vunerability-bot.vercel.app/'; // e.g., https://your-vercel-app.vercel.app/webhook
const KV_URL = process.env.KV_URL; // Vercel KV Redis URL
const PORT = process.env.PORT || 3000;

// Initialize bot in polling mode initially (switch to webhook after deploy)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Initialize KV client
const kv = createClient({ url: KV_URL });

// Helper: Store chat ID if it's a group or private chat
async function storeChatId(chatId, chatType) {
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'private') {
    const key = `chat:${chatId}`;
    await kv.set(key, { chatId, type: chatType, addedAt: new Date().toISOString() });
    console.log(`Stored chat ${chatId} (${chatType})`);
  }
}

// Helper: Get all stored chat IDs
async function getAllChatIds() {
  // For simplicity, store a set of chat IDs in a single key (comma-separated string)
  const allChatsKey = 'all_chats';
  const allIdsStr = await kv.get(allChatsKey) || '';
  return allIdsStr ? allIdsStr.split(',') : [];
}

// Helper: Add to all chats list
async function addToAllChats(chatId) {
  const allChatsKey = 'all_chats';
  let allIdsStr = await kv.get(allChatsKey) || '';
  if (!allIdsStr.includes(chatId.toString())) {
    allIdsStr += (allIdsStr ? ',' : '') + chatId;
    await kv.set(allChatsKey, allIdsStr);
  }
}

// Bot event: Handle new chat members (when added to group)
bot.on('new_chat_members', async (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  await storeChatId(chatId, chatType);
  await addToAllChats(chatId);
  // Optional: Send welcome message
  bot.sendMessage(chatId, 'Hi! I\'m your Jira Daily Bot. I\'ll send task reports daily. Use /report for manual.');
});

// Bot event: Handle /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  await storeChatId(chatId, chatType);
  await addToAllChats(chatId);
  bot.sendMessage(chatId, 'Bot started! Add me to groups for daily Jira reports.');
});

// Optional: /report command for manual trigger (bot sends a placeholder)
bot.onText(/\/report/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Manual report triggered—check with admin for full setup.');
});

// API Endpoint: /send-report (called by n8n with POST { message: "formatted list" })
app.post('/send-report', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'No message provided' });
  }

  try {
    const chatIds = await getAllChatIds();
    if (chatIds.length === 0) {
      console.log('No chats registered');
      return res.json({ sentTo: 0 });
    }

    let sentCount = 0;
    for (const chatIdStr of chatIds) {
      const chatId = parseInt(chatIdStr);
      try {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }); // Supports bold/italics from n8n
        sentCount++;
      } catch (err) {
        console.error(`Failed to send to ${chatId}: ${err.message}`);
        // Optional: Remove invalid chats
        if (err.message.includes('chat not found') || err.message.includes('blocked')) {
          await removeFromAllChats(chatIdStr);
        }
      }
    }
    res.json({ sentTo: sentCount, totalChats: chatIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send reports' });
  }
});

// Helper: Remove invalid chat
async function removeFromAllChats(chatIdStr) {
  const allChatsKey = 'all_chats';
  let allIdsStr = await kv.get(allChatsKey) || '';
  allIdsStr = allIdsStr.replace(new RegExp(`,?${chatIdStr}(,|$)`, 'g'), '');
  await kv.set(allChatsKey, allIdsStr || '');
}

// Webhook setup endpoint (call once after deploy to set Telegram webhook)
app.get('/set-webhook', (req, res) => {
  bot.setWebHook(WEBHOOK_URL)
    .then(() => {
      console.log('Webhook set!');
      res.send('Webhook set successfully');
    })
    .catch(err => {
      console.error(err);
      res.status(500).send('Failed to set webhook');
    });
});

// For Vercel: Export as serverless (but Express works fine)
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
  // Stop polling once webhook is set (manual step)
  // bot.stopPolling();
});

module.exports = app; // For Vercel serverless