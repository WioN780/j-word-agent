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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { pathToFileURL } from "url";
import dotenv from "dotenv";
import { spawn } from "child_process";
import path from "path";
import yaml from "js-yaml";
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
    return { kept: [], skipped: [], pendingCards: {}, chatMode: false, chatHistory: [], autoPilotPending: {}, lastUsageCheck: 0 };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return {
      kept: Array.isArray(s.kept) ? s.kept : [],
      skipped: Array.isArray(s.skipped) ? s.skipped : [],
      pendingCards: s.pendingCards && typeof s.pendingCards === "object" ? s.pendingCards : {},
      chatMode: !!s.chatMode,
      chatHistory: Array.isArray(s.chatHistory) ? s.chatHistory : [],
      autoPilotPending: s.autoPilotPending && typeof s.autoPilotPending === "object" ? s.autoPilotPending : {},
      lastUsageCheck: typeof s.lastUsageCheck === "number" ? s.lastUsageCheck : 0,
    };
  } catch {
    return { kept: [], skipped: [], pendingCards: {}, chatMode: false, chatHistory: [], autoPilotPending: {}, lastUsageCheck: 0 };
  }
}

function saveState(state) {
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// Run a process with stdin support
function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const stdoutBuf = [];
    const stderrBuf = [];
    const stdio = [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"];

    const child = spawn(cmd, args, {
      stdio,
      ...opts,
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    child.stdout.on("data", (d) => stdoutBuf.push(d.toString()));
    child.stderr.on("data", (d) => stderrBuf.push(d.toString()));

    child.on("close", (code) => {
      resolve({ code, stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") });
    });
    child.on("error", reject);
  });
}

function getReportByNum(numStr) {
  const num = numStr.trim().padStart(3, "0");
  const reportsDir = "reports";
  if (!existsSync(reportsDir)) return null;
  const files = readdirSync(reportsDir);
  const file = files.find(f => f.startsWith(`${num}-`) && f.endsWith(".md"));
  if (!file) return null;
  return path.join(reportsDir, file);
}

function getPdfByNum(numStr) {
  const num = numStr.trim().padStart(3, "0");
  const reportsDir = "reports";
  if (!existsSync(reportsDir)) return null;
  const files = readdirSync(reportsDir);
  const reportFile = files.find(f => f.startsWith(`${num}-`) && f.endsWith(".md"));
  if (!reportFile) return null;

  // format: num-slug-YYYY-MM-DD.md
  const parts = reportFile.replace(/\.md$/, "").split("-");
  if (parts.length < 5) return null;
  const date = parts.slice(-3).join("-");
  const slug = parts.slice(1, -3).join("-");
  
  const pdfPath = path.join("output", `cv-${slug}-${date}.pdf`);
  if (existsSync(pdfPath)) {
    return pdfPath;
  }
  return null;
}

function markdownToTelegramHtml(md) {
  return md
    .split("\n")
    .map(line => {
      if (line.startsWith("#")) {
        const title = line.replace(/^#+\s*/, "");
        return `<b>${escapeHtml(title)}</b>`;
      }
      let formatted = line;
      formatted = escapeHtml(formatted);
      formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
      formatted = formatted.replace(/\*(.*?)\*/g, "<i>$1</i>");
      formatted = formatted.replace(/`(.*?)`/g, "<code>$1</code>");
      return formatted;
    })
    .join("\n");
}

function getAgentCli() {
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  const paths = (process.env.PATH || "").split(isWin ? ";" : ":");
  
  const onPath = (cmd) => {
    for (const dir of paths) {
      if (!dir) continue;
      for (const ext of exts) {
        try {
          if (existsSync(path.join(dir, cmd + ext))) return true;
        } catch {}
      }
    }
    return false;
  };

  if (onPath("agy")) return { cmd: "agy", args: ["-p"] };
  if (onPath("claude")) return { cmd: "claude", args: ["-p"] };
  if (onPath("opencode")) return { cmd: "opencode", args: ["run"] };
  if (onPath("copilot")) return { cmd: "copilot", args: ["-p"] };
  if (onPath("codex")) return { cmd: "codex", args: ["exec"] };
  if (onPath("qwen")) return { cmd: "qwen", args: ["-p"] };
  if (onPath("grok")) return { cmd: "grok", args: ["-p"] };

  return { cmd: "claude", args: ["-p"] };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// EU-FORK: persistent keyboard reads scheduler-state for Pause↔Resume label
function buildNavKeyboard() {
  let isPaused = false;
  try {
    const raw = readFileSync("data/scheduler-state.json", "utf-8");
    isPaused = !!JSON.parse(raw).paused;
  } catch {}
  return {
    keyboard: [
      [{ text: "/status" }, { text: "/scan" }, { text: "/pending" }],
      [{ text: "/ranked" }, { text: "/usage" }, { text: isPaused ? "/resume" : "/pause" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// EU-FORK: unified inline card keyboard — Row 1 always Keep|Skip|Later, Row 2 conditional on ATS tier
function buildCardKeyboard(atsTier) {
  const row1 = [
    { text: "✅ Keep", callback_data: "keep" },
    { text: "❌ Skip", callback_data: "skip" },
    { text: "⏰ Later", callback_data: "later" },
  ];
  if (atsTier === 1) return { inline_keyboard: [row1, [{ text: "📋 Apply", callback_data: "apply" }]] };
  return { inline_keyboard: [row1] };
}

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

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildCardKeyboard(tier),
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
    reply_markup: buildCardKeyboard(job.tier),
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

async function editMessageWithNextJob(bot, chatId, messageId) {
  const state = loadState();
  const job = getNextPipelineJob(state);

  if (!job) {
    await bot
      .editMessageText(
        "✅ No more jobs to review!\n\nRun <code>node scan.mjs --notify</code> to scan for more, or <code>/ranked</code> to see scored offers.",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }
      )
      .catch(() => {});
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

  await bot
    .editMessageText(cardLines.join("\n"), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildCardKeyboard(job.tier),
    })
    .catch(() => {});

  state.pendingCards[String(messageId)] = {
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
      { command: "start",       description: "Show help and navigation" },
      { command: "status",      description: "System status & activity" },
      { command: "scan",        description: "Scan job boards in background" },
      { command: "pending",     description: "List jobs awaiting your review" },
      { command: "ranked",      description: "Top-scored evaluated offers" },
      { command: "usage",       description: "Check Claude Code quota usage" },
      { command: "pause",       description: "Pause the autonomous scheduler" },
      { command: "resume",      description: "Resume the autonomous scheduler" },
      { command: "profile",     description: "Show targeting summary & live portfolio" },
      { command: "chat",        description: "Toggle chat mode (or /chat <msg> single-shot)" },
      { command: "autopilot",   description: "Enable/disable auto-apply: /autopilot on|off" },
      { command: "report",      description: "View evaluation report: /report <num>" },
      { command: "pdf",         description: "Get tailored CV PDF: /pdf <num>" },
      { command: "linkedin",    description: "Search LinkedIn: /linkedin <keywords>" },
    ])
    .catch((err) => console.error(`setMyCommands failed: ${err.message}`));

  // EU-FORK: persistent keyboard — 2 rows × 3 buttons; Pause↔Resume flips based on scheduler state
  await bot
    .sendMessage(chatId, "🤖 <b>career-ops bot ready</b> — buttons pinned below", {
      parse_mode: "HTML",
      reply_markup: buildNavKeyboard(),
    })
    .catch(() => {/* ignore if chat not yet initiated */});

  // ── /start command ────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const lines = [
      "👋 <b>career-ops bot</b>",
      "",
      "<b>Commands:</b>",
      "  /status — Scheduler health + today's stats",
      "  /scan — Trigger job scan in background",
      "  /pending — Jobs awaiting your review",
      "  /ranked — Top-scored offers (evaluated by Gemini)",
      "  /usage — Claude Code quota usage",
      "  /pause / /resume — Stop or restart autonomous scanning",
      "  /profile — Your targeting summary + live portfolio sync",
      "  /chat — Toggle chat mode (or <code>/chat &lt;msg&gt;</code> for one-shot)",
      "  /autopilot on|off — Enable hybrid auto-apply for Tier 1 jobs",
      "  /report &lt;num&gt; — Read evaluation report",
      "  /pdf &lt;num&gt; — Get tailored CV PDF",
      "  /linkedin &lt;keywords&gt; — Search LinkedIn",
      "",
      "<b>Workflow:</b>",
      "  1. /scan finds new job posts (runs automatically on schedule)",
      "  2. /pending lists them — tap Keep / Skip / Later on each card",
      "  3. Gemini evaluates kept jobs automatically",
      "  4. /ranked shows your best matches",
      "  5. /report &lt;num&gt; reads the AI assessment, /pdf &lt;num&gt; gets the CV",
    ];

    await bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: buildNavKeyboard(),
    });
  });

  bot.on("callback_query", async (query) => {
    // Ignore callbacks from other chats (security: only our personal chat)
    if (String(query.message?.chat?.id) !== String(chatId)) return;

    const action = query.data;
    const msgId = String(query.message.message_id);
    const state = loadState();

    // EU-FORK: autopilot callbacks resolved from autoPilotPending (separate from pendingCards)
    const autoPilotJob = state.autoPilotPending?.[msgId];
    if (autoPilotJob && (action === "autopilot_yes" || action === "autopilot_no")) {
      delete state.autoPilotPending[msgId];
      saveState(state);
      if (action === "autopilot_no") {
        await bot.answerCallbackQuery(query.id, { text: "❌ Skipped" });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
        return;
      }
      // EU-FORK: autopilot_yes — update trust ramp, then route through relay flow
      // deliberate design: always requires user tap (NEVER submits without review)
      await bot.answerCallbackQuery(query.id, { text: "🚀 Opening relay…" });
      const SCHED_PATH = "data/scheduler-state.json";
      try {
        const ss = existsSync(SCHED_PATH) ? JSON.parse(readFileSync(SCHED_PATH, "utf-8")) : {};
        if (!ss.autoPilot) ss.autoPilot = { enabled: true, trialRemaining: 3, todayAutoApplied: 0, submissionLog: [] };
        if (ss.autoPilot.trialRemaining > 0) ss.autoPilot.trialRemaining -= 1;
        ss.autoPilot.todayAutoApplied = (ss.autoPilot.todayAutoApplied || 0) + 1;
        ss.autoPilot.submissionLog = [...(ss.autoPilot.submissionLog || []), {
          date: new Date().toISOString(), url: autoPilotJob.url, company: autoPilotJob.company, role: autoPilotJob.role, score: autoPilotJob.score,
        }];
        writeFileSync(SCHED_PATH, JSON.stringify(ss, null, 2), "utf-8");
      } catch (err) { console.error(`autopilot state update failed: ${err.message}`); }
      // Route through relay the same way the 'apply' callback does
      const relayUrl = autoPilotJob.jobId ? await getRelayUrlSafe(autoPilotJob.jobId) : null;
      let receipt;
      if (relayUrl) {
        receipt = [
          `📋 <b>Ready for Review</b>`,
          "",
          `🏢 <b>${escapeHtml(autoPilotJob.company)}</b> — ${escapeHtml(autoPilotJob.role)}`,
          `⭐ Score: ${autoPilotJob.score}/5 · 🟢 Tier 1`,
          "",
          `Review & submit from your phone:`,
          `<a href="${escapeHtml(relayUrl)}">${escapeHtml(relayUrl)}</a>`,
        ].join("\n");
      } else {
        receipt = [
          `✅ <b>Confirmed</b> — relay not configured`,
          `🏢 <b>${escapeHtml(autoPilotJob.company)}</b> — ${escapeHtml(autoPilotJob.role)}`,
          `⭐ Score: ${autoPilotJob.score}/5`,
          "",
          `Direct link: ${escapeHtml(autoPilotJob.url)}`,
          `📋 Logged in scheduler-state.json`,
          `See docs/RELAY.md to enable one-tap apply.`,
        ].join("\n");
      }
      await bot.sendMessage(chatId, receipt, { parse_mode: "HTML", disable_web_page_preview: true });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
      return;
    }

    // EU-FORK: next_job must resolve before the card guard — /pending summary
    // message is not in pendingCards, so the guard would otherwise block it
    if (action === "next_job") {
      await bot.answerCallbackQuery(query.id, { text: "Loading next job…" });
      if (state.pendingCards[msgId]) {
        delete state.pendingCards[msgId];
        saveState(state);
        await editMessageWithNextJob(bot, query.message.chat.id, query.message.message_id);
      } else {
        await sendNextPipelineJob(bot, chatId);
      }
      return;
    }

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
      await editMessageWithNextJob(bot, query.message.chat.id, query.message.message_id);
      console.log(`  ✅ Kept    — ${card.company} | ${card.title}`);
    } else if (action === "skip") {
      if (!state.skipped.includes(card.url)) state.skipped.push(card.url);
      delete state.pendingCards[msgId];
      saveState(state);
      await bot.answerCallbackQuery(query.id, { text: "❌ Skipped" });
      await editMessageWithNextJob(bot, query.message.chat.id, query.message.message_id);
      console.log(`  ❌ Skipped — ${card.company} | ${card.title}`);
    } else if (action === "later") {
      await bot.answerCallbackQuery(query.id, { text: "⏰ Saved for later" });
      await editMessageWithNextJob(bot, query.message.chat.id, query.message.message_id);
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

  // ── /pending command ──────────────────────────────────────────────────────
  bot.onText(/\/pending(?:\s|$)/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const PIPELINE_PATH = "data/pipeline.md";
    if (!existsSync(PIPELINE_PATH)) {
      await bot.sendMessage(
        chatId,
        "✅ No jobs pending review.\n(Inbox is empty.)",
        { parse_mode: "HTML" }
      );
      return;
    }

    const state = loadState();
    const text = readFileSync(PIPELINE_PATH, "utf-8");
    const pendingLines = text.split("\n").filter(l => /^- \[ \]/.test(l));

    const list = [];
    for (const line of pendingLines) {
      const urlMatch = line.match(/^- \[ \] (\S+)/);
      if (!urlMatch) continue;
      const url = urlMatch[1];
      if (state.kept.includes(url) || state.skipped.includes(url)) continue;

      const parts = line.replace(/^- \[ \] /, "").split(" | ");
      list.push(`${parts[1] || "Unknown"} — ${parts[2] || "Unknown role"}`);
    }

    const totalPending = list.length;
    if (totalPending === 0) {
      await bot.sendMessage(
        chatId,
        "✅ No jobs pending review.\n(All items have been reviewed.)",
        { parse_mode: "HTML" }
      );
      return;
    }

    const displayed = list.slice(0, 15);
    const items = displayed.map((l, i) => `${i + 1}. ${escapeHtml(l)}`).join("\n");
    const moreText = totalPending > 15 ? `\n... and ${totalPending - 15} more` : "";

    await bot.sendMessage(
      chatId,
      `⏳ <b>Pending Review (${totalPending})</b>\n\n${items}${moreText}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔍 Start Reviewing", callback_data: "next_job" }]]
        }
      }
    );
  });

  // ── /reset command ────────────────────────────────────────────────────────
  bot.onText(/\/(reset|clear_today)(?:\s|$)/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const STATE_PATH = "data/scheduler-state.json";
    if (existsSync(STATE_PATH)) {
      try {
        const s = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
        s.today = {
          date: new Date().toISOString().slice(0, 10),
          scanCycles: 0,
          newOffers: 0,
          cvsGenerated: 0,
          errors: 0,
          evalResults: [],
          highScoringJobs: [],
          morningDigestSent: false,
          limitBypassed: false
        };
        s.paused = false;
        s.circuitOpen = false;
        s.consecutiveScanFailures = 0;
        s.retryAt = null;
        writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), "utf-8");
        
        await bot.sendMessage(
          chatId,
          "🔄 <b>Daily counters reset.</b>\n\nScheduler status: ▶️ Running\nAll limits reset for today.",
          { parse_mode: "HTML" }
        );
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Failed to reset state: ${err.message}`);
      }
    } else {
      await bot.sendMessage(chatId, "⚠️ Scheduler state file not found.", { parse_mode: "HTML" });
    }
  });

  // ── /reset_pending command ──────────────────────────────────────────────────
  bot.onText(/\/(reset_pending|clear_pending)(?:\s|$)/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    try {
      // 1. Clear pending lines from pipeline.md
      const PIPELINE_PATH = "data/pipeline.md";
      if (existsSync(PIPELINE_PATH)) {
        const text = readFileSync(PIPELINE_PATH, "utf-8");
        const lines = text.split("\n");
        const cleanedLines = lines.filter(l => !/^- \[ \]/.test(l));
        writeFileSync(PIPELINE_PATH, cleanedLines.join("\n"), "utf-8");
      }

      // 2. Clear state variables
      const state = loadState();
      state.kept = [];
      state.skipped = [];
      state.pendingCards = {};
      saveState(state);

      await bot.sendMessage(
        chatId,
        "🔄 <b>Pending offers and review states reset.</b>\n\nPipeline inbox has been cleared of pending jobs, and keep/skip stats reset.",
        { parse_mode: "HTML" }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Failed to reset pending: ${err.message}`);
    }
  });

  // ── /status command ───────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    let paused = "unknown";
    let lastScan = "never";
    let nextScan = "unknown";
    let todayCycles = 0;
    let todayNewOffers = 0;
    let todayCvs = 0;
    let todayErrors = 0;
    let circuitLine = "";

    const STATE_PATH = "data/scheduler-state.json";
    if (existsSync(STATE_PATH)) {
      try {
        const s = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
        paused = s.paused ? "⏸ Paused" : "▶️ Running";
        lastScan = s.lastScanTime ? new Date(s.lastScanTime).toLocaleString() : "never";
        nextScan = s.nextScanTime ? new Date(s.nextScanTime).toLocaleString() : "unknown";
        if (s.today) {
          todayCycles = s.today.scanCycles ?? 0;
          todayNewOffers = s.today.newOffers ?? 0;
          todayCvs = s.today.cvsGenerated ?? 0;
          todayErrors = s.today.errors ?? 0;
        }
        if (s.circuitOpen) {
          circuitLine = `\n🔴 Circuit: OPEN (${s.consecutiveScanFailures} failures)`;
        }
      } catch {}
    }

    const PIPELINE_PATH = "data/pipeline.md";
    let pendingCount = 0;
    if (existsSync(PIPELINE_PATH)) {
      const text = readFileSync(PIPELINE_PATH, "utf-8");
      pendingCount = text.split("\n").filter(l => /^- \[ \]/.test(l)).length;
    }

    const lines = [
      "📊 <b>System Status</b>",
      "",
      `Scheduler:  ${paused}${circuitLine}`,
      `Last scan:  ${lastScan}`,
      `Next scan:  ${nextScan}`,
      "",
      "<b>Today's Activity</b>",
      `🔁 Cycles run:    ${todayCycles}`,
      `✨ New offers:    ${todayNewOffers}`,
      `📄 CVs generated: ${todayCvs}`,
      `⏳ Pending review: ${pendingCount}`,
      `⚠️ Errors:        ${todayErrors}`,
    ];

    await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /scan command ─────────────────────────────────────────────────────────
  bot.onText(/\/scan/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    await bot.sendMessage(chatId, "🔍 Starting job scan in background...", {
      parse_mode: "HTML",
    });

    try {
      const child = spawn("node", ["scan.mjs", "--notify"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Failed to start scan: ${err.message}`);
    }
  });

  // EU-FORK: /pause and /resume — control the scheduler and flip keyboard label
  bot.onText(/\/pause(?:\s|$)/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;
    const SCHED_PATH = "data/scheduler-state.json";
    try {
      const ss = existsSync(SCHED_PATH) ? JSON.parse(readFileSync(SCHED_PATH, "utf-8")) : {};
      ss.paused = true;
      writeFileSync(SCHED_PATH, JSON.stringify(ss, null, 2), "utf-8");
      await bot.sendMessage(chatId, "⏸ <b>Scheduler paused.</b> Run /resume to continue.", {
        parse_mode: "HTML",
        reply_markup: buildNavKeyboard(),
      });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Failed to pause: ${err.message}`);
    }
  });

  bot.onText(/\/resume(?:\s|$)/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;
    const SCHED_PATH = "data/scheduler-state.json";
    try {
      const ss = existsSync(SCHED_PATH) ? JSON.parse(readFileSync(SCHED_PATH, "utf-8")) : {};
      ss.paused = false;
      writeFileSync(SCHED_PATH, JSON.stringify(ss, null, 2), "utf-8");
      await bot.sendMessage(chatId, "▶️ <b>Scheduler resumed.</b>", {
        parse_mode: "HTML",
        reply_markup: buildNavKeyboard(),
      });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Failed to resume: ${err.message}`);
    }
  });

  // EU-FORK: /profile — live portfolio sync + targeting summary
  bot.onText(/\/profile(?:\s|$)/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;
    await bot.sendMessage(chatId, "🔄 Fetching live portfolio…", { parse_mode: "HTML" });

    let targetRoles = [];
    let portfolioUrl = "";
    let profileName = "";
    try {
      const yml = existsSync("config/profile.yml")
        ? yaml.load(readFileSync("config/profile.yml", "utf-8"))
        : {};
      targetRoles = yml?.target_roles?.archetypes?.map(a => a.name) || [];
      portfolioUrl = yml?.candidate?.portfolio_url || "";
      profileName = yml?.candidate?.full_name || "";
    } catch {}

    // Read cached portfolio (written by scheduler on each scan cycle)
    let projectsMd = "";
    const cachePath = "data/projects-cache.md";
    if (existsSync(cachePath)) {
      projectsMd = readFileSync(cachePath, "utf-8");
    } else if (existsSync("projects.md")) {
      projectsMd = readFileSync("projects.md", "utf-8");
    }

    const projectTitles = [...projectsMd.matchAll(/^### (.+)$/gm)].map(m => m[1].trim());
    const lines = [
      `👤 <b>${escapeHtml(profileName || "Your Profile")}</b>`,
      "",
      `<b>Target roles:</b> ${escapeHtml(targetRoles.join(", ") || "not set")}`,
      "",
      projectTitles.length > 0
        ? `<b>Live portfolio</b> (${projectTitles.length} projects):\n${projectTitles.slice(0, 8).map(t => `• ${escapeHtml(t)}`).join("\n")}`
        : "⚠️ No portfolio cache — run a scan cycle to fetch live projects.",
    ];

    const buttons = [];
    if (portfolioUrl) {
      buttons.push([
        { text: "🌐 View CV", url: `${portfolioUrl}/cv` },
        { text: "📂 View projects", url: portfolioUrl },
      ]);
    }

    await bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
    });
  });

  // EU-FORK: /autopilot on|off — enable/disable hybrid auto-apply
  bot.onText(/\/autopilot(?:\s+(.+))?/, async (msg, match) => {
    if (String(msg.chat?.id) !== String(chatId)) return;
    const arg = match?.[1]?.trim().toLowerCase();
    const SCHED_PATH = "data/scheduler-state.json";
    try {
      const ss = existsSync(SCHED_PATH) ? JSON.parse(readFileSync(SCHED_PATH, "utf-8")) : {};
      if (!ss.autoPilot) ss.autoPilot = { trialRemaining: 3, todayAutoApplied: 0, submissionLog: [] };

      if (arg === "on") {
        ss.autoPilot.enabled = true;
        writeFileSync(SCHED_PATH, JSON.stringify(ss, null, 2), "utf-8");
        const trial = ss.autoPilot.trialRemaining ?? 3;
        await bot.sendMessage(chatId, [
          `🤖 <b>Auto-pilot ON</b>`,
          trial > 0
            ? `⚠️ Trial mode: first ${trial} eligible job(s) will ask for confirmation before applying.`
            : `✅ Trust established — eligible Tier 1 jobs will auto-apply (min score set in config/scheduler.yml).`,
        ].join("\n"), { parse_mode: "HTML" });
      } else if (arg === "off") {
        ss.autoPilot.enabled = false;
        writeFileSync(SCHED_PATH, JSON.stringify(ss, null, 2), "utf-8");
        await bot.sendMessage(chatId, "🛑 <b>Auto-pilot OFF</b> — no jobs will be submitted automatically.", { parse_mode: "HTML" });
      } else {
        const status = ss.autoPilot.enabled ? "ON" : "OFF";
        const trial = ss.autoPilot.trialRemaining ?? 3;
        const applied = ss.autoPilot.submissionLog?.length || 0;
        await bot.sendMessage(chatId, [
          `🤖 <b>Auto-pilot: ${status}</b>`,
          `Trial confirmations remaining: ${trial}`,
          `Total auto-applied: ${applied}`,
          ``,
          `Use <code>/autopilot on</code> or <code>/autopilot off</code>`,
        ].join("\n"), { parse_mode: "HTML" });
      }
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Failed to update autopilot: ${err.message}`);
    }
  });

  // ── /eval command ─────────────────────────────────────────────────────────
  bot.onText(/\/eval/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    await bot.sendMessage(chatId, "🤖 Starting AI evaluation cycle in background...", {
      parse_mode: "HTML",
    });

    try {
      const child = spawn("node", ["scheduler.mjs", "--once"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Failed to start evaluation: ${err.message}`);
    }
  });

  // ── /report command ───────────────────────────────────────────────────────
  bot.onText(/\/report(?:\s+(\d+))?/, async (msg, match) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const numStr = match?.[1];
    if (!numStr) {
      await bot.sendMessage(chatId, "⚠️ Usage: <code>/report &lt;number&gt;</code> (e.g. <code>/report 003</code>)", { parse_mode: "HTML" });
      return;
    }

    const reportFile = getReportByNum(numStr);
    if (!reportFile) {
      await bot.sendMessage(chatId, `❌ Report for job #${numStr.padStart(3, "0")} not found.`, { parse_mode: "HTML" });
      return;
    }

    try {
      const content = readFileSync(reportFile, "utf-8");
      const htmlContent = markdownToTelegramHtml(content);
      const truncated = htmlContent.length > 4000 
        ? htmlContent.slice(0, 4000) + "\n\n<i>[Truncated...]</i>" 
        : htmlContent;

      await bot.sendMessage(chatId, truncated, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error reading report: ${err.message}`);
    }
  });

  // ── /pdf command ──────────────────────────────────────────────────────────
  bot.onText(/\/pdf(?:\s+(\d+))?/, async (msg, match) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const numStr = match?.[1];
    if (!numStr) {
      await bot.sendMessage(chatId, "⚠️ Usage: <code>/pdf &lt;number&gt;</code> (e.g. <code>/pdf 003</code>)", { parse_mode: "HTML" });
      return;
    }

    const pdfFile = getPdfByNum(numStr);
    if (!pdfFile) {
      await bot.sendMessage(chatId, `❌ PDF for job #${numStr.padStart(3, "0")} not found. Make sure it scored high enough to generate documents.`, { parse_mode: "HTML" });
      return;
    }

    try {
      await bot.sendMessage(chatId, "📤 Sending PDF...", { parse_mode: "HTML" });
      await bot.sendDocument(chatId, pdfFile);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error sending PDF: ${err.message}`);
    }
  });

  // ── /usage command ────────────────────────────────────────────────────────
  bot.onText(/\/usage(?:\s|$)/, async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    // EU-FORK: 60s cooldown to avoid spamming claude --print
    const state = loadState();
    const now = Date.now();
    if (state.lastUsageCheck && now - state.lastUsageCheck < 60_000) {
      const remaining = Math.ceil((60_000 - (now - state.lastUsageCheck)) / 1000);
      await bot.sendMessage(chatId, `⏳ Please wait ${remaining}s before checking usage again.`, { parse_mode: "HTML" });
      return;
    }
    state.lastUsageCheck = now;
    saveState(state);

    await bot.sendMessage(chatId, "⏳ Checking Claude usage…", {
      parse_mode: "HTML",
    });

    try {
      const runEnv = { ...process.env };
      delete runEnv.CLAUDE_API_KEY;
      delete runEnv.ANTHROPIC_API_KEY;
      delete runEnv.CLAUDE_CODE_OAUTH_TOKEN;
      delete runEnv.CLAUOAUTH_TOKEN;
      delete runEnv.CLAUDE_OAUTH_TOKEN;
      const result = await runProcess("claude", ["--print"], { timeout: 20_000, stdin: "/usage\n", env: runEnv });
      if (result.code !== 0 || !result.stdout.trim()) {
        await bot.sendMessage(chatId, "⚠️ No active Claude session or <code>claude</code> not on PATH.\nCannot fetch usage right now.", { parse_mode: "HTML" });
        return;
      }
      
      const out = result.stdout;
      
      let sessionText = "";
      const sessionMatch = out.match(/Current session:\s*(\d+)%\s*used\s*·\s*resets\s*([^\n\r]+)/i);
      if (sessionMatch) {
        const used = parseInt(sessionMatch[1], 10);
        const left = Math.max(0, 100 - used);
        const resets = sessionMatch[2].trim();
        sessionText = `⏳ <b>5-Hour Session:</b> ${used}% used (${left}% left) · Resets ${resets}`;
      }

      let weekText = "";
      const weekMatch = out.match(/Current week(?:\s*\(.*?\))?:\s*(\d+)%\s*used\s*·\s*resets\s*([^\n\r]+)/i);
      if (weekMatch) {
        const used = parseInt(weekMatch[1], 10);
        const left = Math.max(0, 100 - used);
        const resets = weekMatch[2].trim();
        weekText = `📅 <b>Weekly Limit:</b> ${used}% used (${left}% left) · Resets ${resets}`;
      }

      let costText = "";
      const costMatch = out.match(/Total cost:\s*([^\n\r]+)/i);
      if (costMatch) {
        costText = `💰 <b>Total Session Cost:</b> ${costMatch[1].trim()}`;
      }

      let usageText = "";
      const usageMatch = out.match(/Usage:\s*([^\n\r]+)/i);
      if (usageMatch) {
        usageText = `📊 <b>Token Usage:</b> ${usageMatch[1].trim()}`;
      }

      let responseText = "";
      if (sessionText || weekText) {
        responseText = "<b>Claude Quota Usage</b>\n\n";
        if (sessionText) responseText += sessionText + "\n";
        if (weekText) responseText += weekText + "\n";
      } else {
        responseText = "<b>Claude Quota Usage (OAuth/API Mode)</b>\n\n";
        if (costText) responseText += costText + "\n";
        if (usageText) responseText += usageText + "\n";
        responseText += "\n<i>Note: Subscription rate limits are only visible when logged in via a local browser session. Run <code>claude login</code> in your terminal if you want to see them here.</i>";
      }

      await bot.sendMessage(chatId, responseText, { parse_mode: "HTML" });
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Usage check failed: ${err.message.slice(0, 200)}`, { parse_mode: "HTML" });
    }
  });

  // EU-FORK: /chat — no args toggles persistent chat mode; /chat <msg> is always single-shot
  bot.onText(/\/chat(?:\s+(.+))?/, async (msg, match) => {
    if (String(msg.chat?.id) !== String(chatId)) return;

    const userMessage = match?.[1]?.trim();

    // Toggle mode when called with no argument
    if (!userMessage) {
      const state = loadState();
      state.chatMode = !state.chatMode;
      if (!state.chatMode) state.chatHistory = []; // clear history on exit
      saveState(state);
      await bot.sendMessage(
        chatId,
        state.chatMode
          ? "💬 <b>Chat mode ON</b> — send any message to talk to the agent.\nSlash commands still work. /chat again to exit."
          : "💬 <b>Chat mode OFF</b>",
        { parse_mode: "HTML" }
      );
      return;
    }

    // Single-shot: run with conversation history from chat mode (if any), then respond
    const state = loadState();
    const historySnippet = state.chatHistory.slice(-6)
      .map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
      .join("\n");
    const fullPrompt = historySnippet
      ? `Conversation so far:\n${historySnippet}\n\nUser: ${userMessage}`
      : userMessage;

    await bot.sendMessage(chatId, "🤖 Thinking… (10-30s)", { parse_mode: "HTML" });

    try {
      const cli = getAgentCli();
      const result = await runProcess(cli.cmd, [...cli.args, fullPrompt], {
        timeout: 120_000,
        shell: process.platform === "win32",
      });

      const reply = result.code !== 0
        ? `⚠️ Agent failed (exit ${result.code}).\n\n${result.stderr || ""}`.slice(0, 4000)
        : `💬 ${result.stdout.trim()}`.slice(0, 4000);

      if (state.chatMode) {
        state.chatHistory.push({ role: "user", content: userMessage });
        state.chatHistory.push({ role: "assistant", content: result.stdout.trim().slice(0, 1000) });
        if (state.chatHistory.length > 20) state.chatHistory = state.chatHistory.slice(-20);
        saveState(state);
      }

      await bot.sendMessage(chatId, reply, { parse_mode: "HTML" });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Agent error: ${err.message}`);
    }
  });

  // EU-FORK: generic message handler — routes to agent in chat mode, shows hint otherwise
  bot.on("message", async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;
    if (!msg.text || msg.text.startsWith("/")) return;

    const state = loadState();
    if (!state.chatMode) {
      await bot.sendMessage(
        chatId,
        `💬 Tip: use <code>/chat</code> to toggle chat mode, or <code>/chat ${escapeHtml(msg.text)}</code> for a one-shot question.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Chat mode — route to agent with history
    const historySnippet = state.chatHistory.slice(-6)
      .map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
      .join("\n");
    const fullPrompt = historySnippet
      ? `Conversation so far:\n${historySnippet}\n\nUser: ${msg.text}`
      : msg.text;

    await bot.sendMessage(chatId, "🤖 Thinking…", { parse_mode: "HTML" });

    try {
      const cli = getAgentCli();
      const result = await runProcess(cli.cmd, [...cli.args, fullPrompt], {
        timeout: 120_000,
        shell: process.platform === "win32",
      });

      const reply = result.code !== 0
        ? `⚠️ Agent failed.\n\n${result.stderr || ""}`.slice(0, 4000)
        : result.stdout.trim().slice(0, 4000);

      state.chatHistory.push({ role: "user", content: msg.text.slice(0, 500) });
      state.chatHistory.push({ role: "assistant", content: result.stdout.trim().slice(0, 1000) });
      if (state.chatHistory.length > 20) state.chatHistory = state.chatHistory.slice(-20);
      saveState(state);

      await bot.sendMessage(chatId, reply, { parse_mode: "HTML" });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Agent error: ${err.message}`);
    }
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
    lines.push("", "<i>Tip: /report &lt;num&gt; for full assessment · /pdf &lt;num&gt; for tailored CV</i>");

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
