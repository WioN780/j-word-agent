#!/usr/bin/env node
/**
 * telegram-bot.mjs — Telegram notifications for new job offers found by scan.mjs.
 *
 * Relay integration (Stage 4):
 *   When a Tier 1 job is ready for review, sends a link to the relay server
 *   so the user can approve/reject from their phone via Tailscale.
 *   See docs/RELAY.md for setup.
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

import TelegramBot from "node-telegram-bot-api";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { pathToFileURL } from "url";
import dotenv from "dotenv";
import { detectATS } from "./ats-detector.mjs";
import { generateAndSaveApplyCard } from "./apply-card.mjs";

// Relay integration — lazy-loaded to avoid hard dependency
let _getRelayUrl = null;
async function getRelayUrlSafe(jobId) {
  if (_getRelayUrl === null) {
    try {
      const mod = await import("./relay-server.mjs");
      _getRelayUrl = mod.getRelayUrl;
    } catch {
      _getRelayUrl = () => null;
    }
  }
  return _getRelayUrl(jobId);
}

dotenv.config();

const STATE_PATH = "data/telegram-state.json";

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH))
    return { kept: [], skipped: [], pendingCards: {} };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return {
      kept: Array.isArray(s.kept) ? s.kept : [],
      skipped: Array.isArray(s.skipped) ? s.skipped : [],
      pendingCards:
        s.pendingCards && typeof s.pendingCards === "object"
          ? s.pendingCards
          : {},
    };
  } catch {
    return { kept: [], skipped: [], pendingCards: {} };
  }
}

function saveState(state) {
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Map provider source IDs to human-readable portal names.
const SOURCE_LABELS = {
  "greenhouse-api": "Greenhouse",
  "lever-api": "Lever",
  "ashby-api": "Ashby",
  "workday-api": "Workday",
  "workable-api": "Workable",
  "smartrecruiters-api": "SmartRecruiters",
  "breezy-api": "Breezy",
  "justjoin-api": "JustJoin.it",
  "nofluffjobs-api": "NoFluffJobs",
  "remotive-cat-api": "Remotive",
  "local-parser": "Direct",
};

// ATS tier badges shown in job cards.
const TIER_BADGE = {
  1: { emoji: "🟢", label: "Can auto-fill" },
  2: { emoji: "🟡", label: "Partial auto-fill" },
  3: { emoji: "🔴", label: "Manual apply" },
};

// Detect ATS type from URL hostname (separate from portal/source).
const ATS_HOST_MAP = {
  "greenhouse.io": "Greenhouse",
  "lever.co": "Lever",
  "ashbyhq.com": "Ashby",
  "myworkdayjobs.com": "Workday",
  "workable.com": "Workable",
  "smartrecruiters.com": "SmartRecruiters",
  "breezy.hr": "Breezy",
  "justjoin.it": "JustJoin.it",
  "nofluffjobs.com": "NoFluffJobs",
  "remotive.com": "Remotive",
  "jobs.lever.co": "Lever",
  "boards.greenhouse.io": "Greenhouse",
  "job-boards.greenhouse.io": "Greenhouse",
};

function detectAtsType(job) {
  try {
    const host = new URL(job.url).hostname.toLowerCase();
    for (const [pattern, label] of Object.entries(ATS_HOST_MAP)) {
      if (host === pattern || host.endsWith(`.${pattern}`)) return label;
    }
  } catch {
    /* invalid URL — fall through */
  }
  return SOURCE_LABELS[job.source] || job.source || "Unknown";
}

function prettySource(source) {
  return SOURCE_LABELS[source] || source || "Unknown";
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

  // Build relay URL for Tier 1 jobs
  const jobId = (() => {
    try {
      return new URL(job.url).pathname.split("/").filter(Boolean).pop() || null;
    } catch {
      return null;
    }
  })();
  const relayUrl = tier === 1 && jobId ? await getRelayUrlSafe(jobId) : null;

  const textLines = [
    "🔍 <b>New Job Found</b>",
    "",
    `🏢 <b>${escapeHtml(job.company)}</b> — ${escapeHtml(job.title)}`,
    `📍 ${escapeHtml(job.location || "N/A")}`,
    `${badge.emoji} ${escapeHtml(atsType)} · ${badge.label}`,
    `🔗 ${escapeHtml(job.url)}`,
    "",
    `Source: ${escapeHtml(source)}`,
    `Found: ${date}`,
  ];

  // Append relay link for Tier 1 jobs
  if (relayUrl) {
    textLines.push(
      "",
      `📋 <a href="${escapeHtml(relayUrl)}">Review & submit from your phone</a>`,
    );
  }

  const text = textLines.join("\n");

  const buttonsRow1 = [
    { text: "✅ Keep", callback_data: "keep" },
    { text: "❌ Skip", callback_data: "skip" },
    { text: "⏰ Later", callback_data: "later" },
  ];
  if (tier === 1)
    buttonsRow1.push({ text: "📋 Apply", callback_data: "apply" });

  // All jobs get a "Get Apply Card" button on a second row
  const buttonsRow2 = [
    { text: "📋 Get Apply Card", callback_data: "apply_card" },
  ];

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [buttonsRow1, buttonsRow2] },
  });

  // Store messageId → job mapping so the listener can resolve callbacks without
  // hitting the 64-byte callback_data limit.
  const state = loadState();
  state.pendingCards[String(msg.message_id)] = {
    url: job.url,
    title: job.title,
    company: job.company,
    location: job.location || null,
    source: job.source || null,
    atsTier: tier,
    jobId: jobId,
  };
  saveState(state);

  // For Tier 2/3 jobs, automatically generate and send the apply card
  if (tier >= 2) {
    try {
      const { telegram: cardMarkdown, filePath } =
        generateAndSaveApplyCard(job);
      await bot.sendMessage(chatId, cardMarkdown, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      console.log(`  📋 Apply card saved: ${filePath}`);
    } catch (err) {
      console.error(`  ⚠️ Apply card generation failed: ${err.message}`);
    }
  }
}

/**
 * Send a scan digest message summarising what the scanner found.
 * Accepts an optional `offers` array to list new jobs inline.
 * Silent no-op when credentials are absent.
 */
export async function sendDailySummary(stats) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const bot = new TelegramBot(token, { polling: false });

  const lines = [
    "📊 <b>Scan Complete</b>",
    "",
    `✨ New offers: <b>${stats.newOffers}</b>`,
    `🔄 Duplicates skipped: ${stats.duplicates}`,
    `🏢 Targets scanned: ${stats.companies}`,
  ];
  if (stats.errors > 0) lines.push(`⚠️ Errors: ${stats.errors}`);

  if (Array.isArray(stats.offers) && stats.offers.length > 0) {
    lines.push("", "<b>Found:</b>");
    for (const [i, offer] of stats.offers.slice(0, 15).entries()) {
      const badge = TIER_BADGE[offer.atsTier] ?? TIER_BADGE[3];
      lines.push(`${i + 1}. ${badge.emoji} <b>${escapeHtml(offer.company)}</b> — ${escapeHtml(offer.title)}`);
    }
    if (stats.offers.length > 15) lines.push(`… and ${stats.offers.length - 15} more`);
    lines.push("", "→ /next to review one by one  ·  /ranked after evaluation");
  } else if (stats.newOffers === 0) {
    lines.push("", "No new jobs this scan.");
  } else {
    lines.push("", "→ /next to review one by one");
  }

  await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
}

// ── Pipeline browser helpers ──────────────────────────────────────────────────

function getNextPipelineJob(state) {
  const PIPELINE_PATH = "data/pipeline.md";
  if (!existsSync(PIPELINE_PATH)) return null;

  const text = readFileSync(PIPELINE_PATH, "utf-8");
  const pendingLines = text.split("\n").filter(l => /^- \[ \]/.test(l));

  // Skip jobs already actioned via bot
  for (const line of pendingLines) {
    const urlMatch = line.match(/^- \[ \] (\S+)/);
    if (!urlMatch) continue;
    const url = urlMatch[1];
    if (state.kept.includes(url) || state.skipped.includes(url)) continue;

    // Parse: - [ ] URL | Company | Title | tier:X | ats:Y
    const parts = line.replace(/^- \[ \] /, "").split(" | ");
    const tierMatch = (parts[3] || "").match(/tier:(\d)/);
    const atsMatch = (parts[4] || "").match(/ats:(\w+)/);
    return {
      url,
      company: parts[1] || "Unknown",
      title: parts[2] || "Unknown role",
      tier: tierMatch ? parseInt(tierMatch[1]) : 3,
      atsType: atsMatch ? atsMatch[1] : "Unknown",
      remaining: pendingLines.filter(l => {
        const m = l.match(/^- \[ \] (\S+)/);
        return m && !state.kept.includes(m[1]) && !state.skipped.includes(m[1]);
      }).length,
    };
  }
  return null;
}

async function sendNextPipelineJob(bot, chatId) {
  const state = loadState();
  const job = getNextPipelineJob(state);

  if (!job) {
    await bot.sendMessage(
      chatId,
      "✅ No more jobs to review!\n\nRun <code>node scan.mjs --notify</code> to scan for more, or <code>/ranked</code> to see scored offers.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const badge = TIER_BADGE[job.tier] ?? TIER_BADGE[3];
  const cardLines = [
    `🔍 <b>Job Review</b> — ${job.remaining} pending`,
    "",
    `🏢 <b>${escapeHtml(job.company)}</b> — ${escapeHtml(job.title)}`,
    `${badge.emoji} ${escapeHtml(job.atsType)} · ${badge.label}`,
    `🔗 ${escapeHtml(job.url)}`,
  ];

  const sentMsg = await bot.sendMessage(chatId, cardLines.join("\n"), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Keep", callback_data: "keep" },
          { text: "❌ Skip", callback_data: "skip" },
          { text: "➡️ Next", callback_data: "next_job" },
        ],
        [
          { text: "📋 Apply Card", callback_data: "apply_card" },
        ],
      ],
    },
  });

  state.pendingCards[String(sentMsg.message_id)] = {
    url: job.url,
    title: job.title,
    company: job.company,
    location: null,
    source: job.atsType,
    atsTier: job.tier,
    jobId: null,
  };
  saveState(state);
}

// ── Standalone callback listener ──────────────────────────────────────────────

async function startListener() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) {
    console.error(
      "Error: TELEGRAM_BOT_TOKEN is not set — add it to .env (see docs/TELEGRAM.md)",
    );
    process.exit(1);
  }
  if (!chatId) {
    console.error(
      "Error: TELEGRAM_CHAT_ID is not set — add it to .env (see docs/TELEGRAM.md)",
    );
    process.exit(1);
  }

  console.log(
    "📱 Telegram bot listening for callback events... (Ctrl+C to stop)",
  );
  console.log(`   Chat ID: ${chatId}`);

  const bot = new TelegramBot(token, { polling: true });

  // Register commands in the "/" menu (Bot API: setMyCommands)
  await bot
    .setMyCommands([
      { command: "start",    description: "Show help and navigation" },
      { command: "next",     description: "Review next job from pipeline" },
      { command: "ranked",   description: "Top-scored evaluated offers" },
      { command: "linkedin", description: "Search LinkedIn: /linkedin <keywords>" },
    ])
    .catch((err) => console.error(`setMyCommands failed: ${err.message}`));

  // Send persistent keyboard so buttons are always visible in chat
  const NAV_KEYBOARD = {
    keyboard: [
      [{ text: "/next" }, { text: "/ranked" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };

  await bot
    .sendMessage(chatId, "🤖 <b>career-ops bot ready</b> — buttons pinned below", {
      parse_mode: "HTML",
      reply_markup: NAV_KEYBOARD,
    })
    .catch(() => {/* ignore if chat not yet initiated */});

  // ── /start command ────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const lines = [
      "👋 <b>career-ops bot</b>",
      "",
      "<b>Commands:</b>",
      "  /next — Review next job from pipeline",
      "  /ranked — Top-scored offers after evaluation",
      "  /linkedin &lt;keywords&gt; — Search LinkedIn",
      "",
      "<b>Workflow:</b>",
      "  1. <code>node scan.mjs --notify</code> — scan &amp; get summary",
      "  2. /next — browse found jobs one by one",
      "  3. <code>/career-ops pipeline</code> in Claude — evaluate &amp; score",
      "  4. /ranked — see your best matches",
    ];

    await bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: NAV_KEYBOARD,
    });
  });

  bot.on("callback_query", async (query) => {
    // Ignore callbacks from other chats (security: only our personal chat)
    if (String(query.message?.chat?.id) !== String(chatId)) return;

    const action = query.data;
    const msgId = String(query.message.message_id);
    const state = loadState();
    const card = state.pendingCards[msgId];

    if (!card) {
      await bot.answerCallbackQuery(query.id, {
        text: "Already handled or not tracked",
      });
      return;
    }

    if (action === "keep") {
      if (!state.kept.includes(card.url)) state.kept.push(card.url);
      delete state.pendingCards[msgId];
      saveState(state);
      await bot.answerCallbackQuery(query.id, { text: "✅ Kept!" });
      await bot
        .editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "✅ Kept", callback_data: "noop" }]] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
          },
        )
        .catch(() => {
          /* message may be too old to edit — ignore */
        });
      console.log(`  ✅ Kept    — ${card.company} | ${card.title}`);
    } else if (action === "skip") {
      if (!state.skipped.includes(card.url)) state.skipped.push(card.url);
      delete state.pendingCards[msgId];
      saveState(state);
      await bot.answerCallbackQuery(query.id, { text: "❌ Skipped" });
      await bot
        .editMessageReplyMarkup(
          {
            inline_keyboard: [[{ text: "❌ Skipped", callback_data: "noop" }]],
          },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
          },
        )
        .catch(() => {
          /* message may be too old to edit — ignore */
        });
      console.log(`  ❌ Skipped — ${card.company} | ${card.title}`);
    } else if (action === "later") {
      await bot.answerCallbackQuery(query.id, { text: "⏰ Saved for later" });
      console.log(`  ⏰ Later   — ${card.company} | ${card.title}`);
    } else if (action === "apply") {
      const relayUrl = card.jobId ? await getRelayUrlSafe(card.jobId) : null;

      if (relayUrl) {
        await bot.answerCallbackQuery(query.id, {
          text: "📋 Opening relay review…",
        });
        const followUp = [
          `📋 <b>Ready for Review</b>`,
          "",
          `🏢 <b>${escapeHtml(card.company)}</b> — ${escapeHtml(card.title)}`,
          `🟢 Tier 1 · Can auto-fill`,
          "",
          `Review & submit from your phone:`,
          `<a href="${escapeHtml(relayUrl)}">${escapeHtml(relayUrl)}</a>`,
        ].join("\n");
        await bot.sendMessage(chatId, followUp, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      } else {
        await bot.answerCallbackQuery(query.id, {
          text: "📋 Relay not configured — see docs/RELAY.md",
        });
        const followUp = [
          `📋 Apply flow for <b>${escapeHtml(card.company)}</b> — ${escapeHtml(card.title)}`,
          "",
          "Relay server not configured. Set RELAY_SECRET and PI_HOSTNAME in .env",
          "See docs/RELAY.md for setup instructions.",
          "",
          "Direct link:",
          escapeHtml(card.url),
        ].join("\n");
        await bot.sendMessage(chatId, followUp, { parse_mode: "HTML" });
      }
      console.log(`  📋 Apply    — ${card.company} | ${card.title}`);
    } else if (action === "next_job") {
      await bot.answerCallbackQuery(query.id, { text: "Loading next job…" });
      await bot
        .editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        })
        .catch(() => {});
      await sendNextPipelineJob(bot, chatId);
    } else if (action === "apply_card") {
      // Generate and send an apply data card on demand
      await bot.answerCallbackQuery(query.id, {
        text: "📋 Generating apply card…",
      });
      try {
        const job = {
          url: card.url,
          company: card.company,
          title: card.title,
          location: card.location || null,
          source: card.source || null,
        };
        const { telegram: cardMarkdown, filePath } =
          generateAndSaveApplyCard(job);
        await bot.sendMessage(chatId, cardMarkdown, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        });
        console.log(
          `  📋 Card     — ${card.company} | ${card.title} → ${filePath}`,
        );
      } catch (err) {
        const errorMsg = `⚠️ Could not generate apply card: ${err.message.replace(/([_*`\[])/g, "\\$1")}`;
        await bot.sendMessage(chatId, errorMsg, { parse_mode: "Markdown" });
        console.error(`  ⚠️ Card error — ${card.company} | ${err.message}`);
      }
    }
  });

  bot.on("polling_error", (err) => {
    console.error(`Polling error: ${err.code || ""} ${err.message}`);
  });

  // ── /next command — browse pipeline jobs one by one ──────────────────────
  bot.onText(/\/next/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;
    await sendNextPipelineJob(bot, chatId);
  });

  // ── /ranked command — show top-scored evaluated offers ────────────────────
  bot.onText(/\/ranked/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const APPLICATIONS_PATH = "data/applications.md";
    if (!existsSync(APPLICATIONS_PATH)) {
      await bot.sendMessage(
        chatId,
        "📭 No evaluated offers yet.\n\nRun <code>/career-ops pipeline</code> in Claude Code first.",
        { parse_mode: "HTML" },
      );
      return;
    }

    const text = readFileSync(APPLICATIONS_PATH, "utf-8");
    const rows = [];
    for (const line of text.split("\n")) {
      // Table: | # | Date | Company | Role | Score | Status | ...
      const m = line.match(/^\|\s*\d+\s*\|[^|]+\|\s*([^|]+)\|\s*([^|]+)\|\s*([\d.]+)\/5\s*\|\s*([^|]+)\|/);
      if (!m) continue;
      const score = parseFloat(m[3]);
      if (isNaN(score)) continue;
      rows.push({ company: m[1].trim(), role: m[2].trim(), score, status: m[4].trim() });
    }

    if (rows.length === 0) {
      await bot.sendMessage(
        chatId,
        "📭 No scored offers yet.\n\nRun <code>/career-ops pipeline</code> in Claude Code to evaluate jobs.",
        { parse_mode: "HTML" },
      );
      return;
    }

    rows.sort((a, b) => b.score - a.score);
    const medals = ["🥇", "🥈", "🥉"];
    const lines = [`🏆 <b>Top Offers</b> (${rows.length} evaluated)`, ""];
    for (const [i, r] of rows.slice(0, 10).entries()) {
      const m = medals[i] ?? `${i + 1}.`;
      lines.push(`${m} <b>${escapeHtml(r.company)}</b> — ${escapeHtml(r.role)}`);
      lines.push(`   ⭐ ${r.score}/5 · ${escapeHtml(r.status)}`);
    }
    if (rows.length > 10) lines.push(`\n… and ${rows.length - 10} more`);

    await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /linkedin command ─────────────────────────────────────────────────────
  // Usage:  /linkedin <keywords>
  // Examples:
  //   /linkedin python developer poland
  //   /linkedin backend engineer berlin remote
  //   /linkedin ml engineer amsterdam
  //
  // Fetches from LinkedIn's public guest API (no login, no Playwright).
  // Returns up to 10 results for the first page only.

  bot.onText(/\/linkedin(?:\s+(.+))?/, async (msg, match) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const keywords = match?.[1]?.trim();
    if (!keywords) {
      await bot.sendMessage(
        chatId,
        [
          "🔍 <b>LinkedIn Search</b>",
          "",
          "Usage: <code>/linkedin &lt;keywords&gt;</code>",
          "",
          "Examples:",
          "  <code>/linkedin python developer poland</code>",
          "  <code>/linkedin backend engineer berlin remote</code>",
          "  <code>/linkedin ml engineer amsterdam</code>",
          "",
          "Returns up to 10 results from LinkedIn's public job search.",
          "No login required.",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      `🔍 Searching LinkedIn for: <b>${escapeHtml(keywords)}</b>\n⏳ Fetching (may take 5–10 s)…`,
      { parse_mode: "HTML" },
    );

    try {
      // Lazy-load the provider to avoid hard dependency at startup
      const { fetchLinkedInJobs } =
        await import("./providers/linkedin-guest.mjs");

      const jobs = await fetchLinkedInJobs(keywords, {
        location: "", // keywords often include location already
        f_TPR: "r604800", // past week
        limit: 10,
      });

      if (jobs.length === 0) {
        await bot.sendMessage(
          chatId,
          `🔍 No results found for: <b>${escapeHtml(keywords)}</b>\n\nTry broader keywords or a different location.`,
          { parse_mode: "HTML" },
        );
        return;
      }

      // Send a compact summary message first
      const header = [
        `🔗 <b>LinkedIn — ${escapeHtml(keywords)}</b>`,
        `Found ${jobs.length} job(s) — first page only, past week`,
        "",
      ].join("\n");

      // Build list (keep under Telegram's 4096 char limit)
      const lines = [header];
      for (const [i, job] of jobs.entries()) {
        lines
          .push(
            `${i + 1}. <b>${escapeHtml(job.title)}</b>`,
            `   🏢 ${escapeHtml(job.company)}`,
            job.location ? `   📍 ${escapeHtml(job.location)}` : null,
            `   🔗 <a href="${escapeHtml(job.url)}">${escapeHtml(job.url.replace("https://www.linkedin.com", ""))}</a>`,
            "",
          )
          .filter(Boolean);
      }

      lines.push("→ Tap a link to open the full job posting on LinkedIn.");

      const text = lines.join("\n").slice(0, 4090); // hard cap
      await bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (err) {
      const msg429 =
        err.message?.includes("429") || err.message?.includes("rate-limited")
          ? "\n\n⚠️ LinkedIn rate-limited this IP. Wait a few minutes and try again."
          : "";
      await bot.sendMessage(
        chatId,
        `❌ LinkedIn search failed: ${escapeHtml(err.message)}${msg429}`,
        { parse_mode: "HTML" },
      );
      console.error(`  /linkedin error: ${err.message}`);
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startListener().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
