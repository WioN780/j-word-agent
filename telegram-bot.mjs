#!/usr/bin/env node
/**
 * telegram-bot.mjs — Telegram notifications for new job offers found by scan.mjs.
 *
 * Exports used by scan.mjs --notify:
 *   sendJobCard(job)          — push one card with Keep / Skip / Later buttons
 *   sendDailySummary(stats)   — push a scan digest message
 *
 * Run standalone to handle button callbacks persistently:
 *   node telegram-bot.mjs
 *
 * Telegram queues callback_query updates for ~24 h, so buttons tapped while the
 * listener is down still resolve when it next polls.
 *
 * Setup (see docs/TELEGRAM.md for step-by-step):
 *   TELEGRAM_BOT_TOKEN=<token from @BotFather>
 *   TELEGRAM_CHAT_ID=<your chat ID from @userinfobot>
 *
 * State file: data/telegram-state.json
 *   kept[]           — URLs confirmed by the user
 *   skipped[]        — URLs dismissed (informational; not yet wired into scan dedup)
 *   pendingCards{}   — messageId → {url, title, company} for callback resolution
 *                      (avoids the 64-byte callback_data Telegram limit)
 */

import TelegramBot from 'node-telegram-bot-api';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';
import dotenv from 'dotenv';
import { detectATS } from './ats-detector.mjs';

dotenv.config();

const STATE_PATH = 'data/telegram-state.json';

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) return { kept: [], skipped: [], pendingCards: {} };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    return {
      kept: Array.isArray(s.kept) ? s.kept : [],
      skipped: Array.isArray(s.skipped) ? s.skipped : [],
      pendingCards: (s.pendingCards && typeof s.pendingCards === 'object') ? s.pendingCards : {},
    };
  } catch {
    return { kept: [], skipped: [], pendingCards: {} };
  }
}

function saveState(state) {
  mkdirSync('data', { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Map provider source IDs to human-readable portal names.
const SOURCE_LABELS = {
  'greenhouse-api': 'Greenhouse',
  'lever-api': 'Lever',
  'ashby-api': 'Ashby',
  'workday-api': 'Workday',
  'workable-api': 'Workable',
  'smartrecruiters-api': 'SmartRecruiters',
  'breezy-api': 'Breezy',
  'justjoin-api': 'JustJoin.it',
  'nofluffjobs-api': 'NoFluffJobs',
  'remotive-cat-api': 'Remotive',
  'local-parser': 'Direct',
};

// ATS tier badges shown in job cards.
const TIER_BADGE = {
  1: { emoji: '🟢', label: 'Can auto-fill' },
  2: { emoji: '🟡', label: 'Partial auto-fill' },
  3: { emoji: '🔴', label: 'Manual apply' },
};

// Detect ATS type from URL hostname (separate from portal/source).
const ATS_HOST_MAP = {
  'greenhouse.io': 'Greenhouse',
  'lever.co': 'Lever',
  'ashbyhq.com': 'Ashby',
  'myworkdayjobs.com': 'Workday',
  'workable.com': 'Workable',
  'smartrecruiters.com': 'SmartRecruiters',
  'breezy.hr': 'Breezy',
  'justjoin.it': 'JustJoin.it',
  'nofluffjobs.com': 'NoFluffJobs',
  'remotive.com': 'Remotive',
  'jobs.lever.co': 'Lever',
  'boards.greenhouse.io': 'Greenhouse',
  'job-boards.greenhouse.io': 'Greenhouse',
};

function detectAtsType(job) {
  try {
    const host = new URL(job.url).hostname.toLowerCase();
    for (const [pattern, label] of Object.entries(ATS_HOST_MAP)) {
      if (host === pattern || host.endsWith(`.${pattern}`)) return label;
    }
  } catch { /* invalid URL — fall through */ }
  return SOURCE_LABELS[job.source] || job.source || 'Unknown';
}

function prettySource(source) {
  return SOURCE_LABELS[source] || source || 'Unknown';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send one job card to Telegram with Keep / Skip / Later inline buttons.
 * Silent no-op when TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are absent.
 */
export async function sendJobCard(job) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const bot = new TelegramBot(token, { polling: false });
  const date = new Date().toISOString().slice(0, 10);
  const atsType = detectAtsType(job);
  const source = prettySource(job.source);
  const { tier } = detectATS(job.url);
  const badge = TIER_BADGE[tier] ?? TIER_BADGE[3];

  const text = [
    '🔍 <b>New Job Found</b>',
    '',
    `🏢 <b>${escapeHtml(job.company)}</b> — ${escapeHtml(job.title)}`,
    `📍 ${escapeHtml(job.location || 'N/A')}`,
    `${badge.emoji} ${escapeHtml(atsType)} · ${badge.label}`,
    `🔗 ${escapeHtml(job.url)}`,
    '',
    `Source: ${escapeHtml(source)}`,
    `Found: ${date}`,
  ].join('\n');

  const buttons = [
    { text: '✅ Keep', callback_data: 'keep' },
    { text: '❌ Skip', callback_data: 'skip' },
    { text: '⏰ Later', callback_data: 'later' },
  ];
  if (tier === 1) buttons.push({ text: '📋 Apply', callback_data: 'apply' });

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [buttons] },
  });

  // Store messageId → job mapping so the listener can resolve callbacks without
  // hitting the 64-byte callback_data limit.
  const state = loadState();
  state.pendingCards[String(msg.message_id)] = {
    url: job.url,
    title: job.title,
    company: job.company,
    atsTier: tier,
  };
  saveState(state);
}

/**
 * Send a scan digest message summarising what the scanner found.
 * Silent no-op when credentials are absent.
 */
export async function sendDailySummary(stats) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const bot = new TelegramBot(token, { polling: false });

  const lines = [
    '📊 <b>Scan Summary</b>',
    '',
    `✨ New offers: <b>${stats.newOffers}</b>`,
    `🔄 Duplicates skipped: ${stats.duplicates}`,
    `🏢 Targets scanned: ${stats.companies}`,
  ];
  if (stats.errors > 0) lines.push(`⚠️ Errors: ${stats.errors}`);
  lines.push('', '→ Run <code>/career-ops pipeline</code> to evaluate');

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

// ── Standalone callback listener ──────────────────────────────────────────────

async function startListener() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN is not set — add it to .env (see docs/TELEGRAM.md)');
    process.exit(1);
  }
  if (!chatId) {
    console.error('Error: TELEGRAM_CHAT_ID is not set — add it to .env (see docs/TELEGRAM.md)');
    process.exit(1);
  }

  console.log('📱 Telegram bot listening for callback events... (Ctrl+C to stop)');
  console.log(`   Chat ID: ${chatId}`);

  const bot = new TelegramBot(token, { polling: true });

  bot.on('callback_query', async (query) => {
    // Ignore callbacks from other chats (security: only our personal chat)
    if (String(query.message?.chat?.id) !== String(chatId)) return;

    const action = query.data;
    const msgId = String(query.message.message_id);
    const state = loadState();
    const card = state.pendingCards[msgId];

    if (!card) {
      await bot.answerCallbackQuery(query.id, { text: 'Already handled or not tracked' });
      return;
    }

    if (action === 'keep') {
      if (!state.kept.includes(card.url)) state.kept.push(card.url);
      delete state.pendingCards[msgId];
      saveState(state);
      await bot.answerCallbackQuery(query.id, { text: '✅ Kept!' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: '✅ Kept', callback_data: 'noop' }]] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id },
      ).catch(() => { /* message may be too old to edit — ignore */ });
      console.log(`  ✅ Kept    — ${card.company} | ${card.title}`);

    } else if (action === 'skip') {
      if (!state.skipped.includes(card.url)) state.skipped.push(card.url);
      delete state.pendingCards[msgId];
      saveState(state);
      await bot.answerCallbackQuery(query.id, { text: '❌ Skipped' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: '❌ Skipped', callback_data: 'noop' }]] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id },
      ).catch(() => { /* message may be too old to edit — ignore */ });
      console.log(`  ❌ Skipped — ${card.company} | ${card.title}`);

    } else if (action === 'later') {
      await bot.answerCallbackQuery(query.id, { text: '⏰ Saved for later' });
      console.log(`  ⏰ Later   — ${card.company} | ${card.title}`);

    } else if (action === 'apply') {
      await bot.answerCallbackQuery(query.id, { text: '📋 Apply flow coming in Stage 4' });
      const followUp = [
        `📋 Apply flow for <b>${escapeHtml(card.company)}</b> — ${escapeHtml(card.title)}`,
        '',
        'Coming in Stage 4. Direct link:',
        escapeHtml(card.url),
      ].join('\n');
      await bot.sendMessage(chatId, followUp, { parse_mode: 'HTML' });
      console.log(`  📋 Apply    — ${card.company} | ${card.title}`);
    }
  });

  bot.on('polling_error', (err) => {
    console.error(`Polling error: ${err.code || ''} ${err.message}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startListener().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
