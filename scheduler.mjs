#!/usr/bin/env node
/**
 * scheduler.mjs — Autonomous job-search pipeline orchestrator for RPi.
 *
 * Modes:
 *   node scheduler.mjs --once    — one full scan cycle, then exit
 *   node scheduler.mjs --daemon  — run continuously on configured schedule
 *
 * Config:  config/scheduler.yml
 * Log:     data/scheduler.log
 * State:   data/scheduler-state.json
 *
 * Telegram commands (daemon only):
 *   /status   — scheduler health + today's stats
 *   /scan     — trigger immediate scan
 *   /pause    — pause auto-scanning
 *   /resume   — resume auto-scanning
 *   /start    — alias for /resume
 *   /stop     — alias for /pause
 *   /pending  — list jobs awaiting your review
 *   /usage    — check Claude Code subscription usage
 */

import { spawn } from "child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "fs";
import { pathToFileURL } from "url";
import yaml from "js-yaml";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

// ── Paths ──────────────────────────────────────────────────────────────────────

const CONFIG_PATH = "config/scheduler.yml";
const STATE_PATH = "data/scheduler-state.json";
const LOG_PATH = "data/scheduler.log";
const PIPELINE_PATH = "data/pipeline.md";
const TG_STATE_PATH = "data/telegram-state.json";
const OUTPUT_DIR = "output";

mkdirSync("data", { recursive: true });

// ── Config ─────────────────────────────────────────────────────────────────────

/** @returns {SchedulerConfig} */
function loadConfig() {
  const defaults = {
    scan_interval_hours: 6,
    scan_times: ["08:00", "12:00", "18:00"],
    score_threshold: 3.5,
    max_applications_per_day: 10,
    enabled_stages: ["scan", "cv", "notify"],
    verify_liveness: false,
    daily_summary_time: "20:00",
  };

  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    const raw = yaml.load(readFileSync(CONFIG_PATH, "utf-8")) || {};
    return { ...defaults, ...raw };
  } catch (err) {
    log(
      `⚠️  Config parse error (${CONFIG_PATH}): ${err.message} — using defaults`,
    );
    return defaults;
  }
}

// ── Persistent state ───────────────────────────────────────────────────────────

const BLANK_TODAY = () => ({
  date: null,
  scanCycles: 0,
  newOffers: 0,
  cvsGenerated: 0,
  errors: 0,
});

function loadState() {
  const blank = {
    paused: false,
    lastScanTime: null,
    nextScanTime: null,
    dailySummarySentDate: null,
    today: BLANK_TODAY(),
    // Circuit breaker — tracks consecutive scan failures
    consecutiveScanFailures: 0,
    circuitOpen: false,
    // Auto-retry after transient crash (ISO timestamp or null)
    retryAt: null,
    // Disk warning dedup — date of last disk warning sent
    diskWarnedDate: null,
  };
  if (!existsSync(STATE_PATH)) return blank;
  try {
    return { ...blank, ...JSON.parse(readFileSync(STATE_PATH, "utf-8")) };
  } catch {
    return blank;
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ── Logger ─────────────────────────────────────────────────────────────────────

function log(message) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${message}`;
  console.log(line);
  try {
    appendFileSync(LOG_PATH, line + "\n", "utf-8");
  } catch {
    /* ignore */
  }
}

// ── Time helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Parse "HH:MM" → { hours, minutes } */
function parseHHMM(t) {
  const [h = 0, m = 0] = String(t).split(":").map(Number);
  return { hours: h, minutes: m };
}

/**
 * Return the next Date from scan_times that is still in the future.
 * Falls back to tomorrow's first slot when all of today's slots have passed.
 * Falls back to interval-based scheduling when scan_times is empty.
 */
function computeNextScanTime(config) {
  const now = new Date();

  if (Array.isArray(config.scan_times) && config.scan_times.length > 0) {
    // Build today's candidate dates
    const todayStr = now.toDateString();
    const candidates = config.scan_times
      .map((t) => {
        const { hours, minutes } = parseHHMM(t);
        const d = new Date(todayStr);
        d.setHours(hours, minutes, 0, 0);
        return d;
      })
      .sort((a, b) => a - b);

    const next = candidates.find((d) => d > now);
    if (next) return next;

    // All today's slots passed — schedule for first slot tomorrow
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toDateString();
    const { hours, minutes } = parseHHMM(config.scan_times[0]);
    const d = new Date(tomorrowStr);
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  // Interval-based fallback
  const intervalMs = (config.scan_interval_hours || 6) * 60 * 60 * 1000;
  return new Date(now.getTime() + intervalMs);
}

/** Reset daily counters when the calendar date rolls over. */
function resetDailyIfNeeded(state) {
  if (state.today.date !== todayISO()) {
    state.today = { ...BLANK_TODAY(), date: todayISO() };
  }
  return state;
}

// ── Subprocess runner ──────────────────────────────────────────────────────────

/**
 * Spawn a child process, stream stderr to the scheduler log, and resolve with
 * { code, stdout, stderr }.  stdout is collected silently (we log a summary).
 */
function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const stdoutBuf = [];
    const stderrBuf = [];

    log(`  $ ${cmd} ${args.join(" ")}`);

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });

    child.stdout.on("data", (d) => stdoutBuf.push(d.toString()));
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderrBuf.push(text);
      // Surface stderr in the scheduler log so errors are always visible
      for (const line of text.split("\n")) {
        if (line.trim()) log(`  [err] ${line}`);
      }
    });

    child.on("close", (code) => {
      resolve({ code, stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") });
    });

    child.on("error", reject);
  });
}

// ── Output parsing ─────────────────────────────────────────────────────────────

/**
 * Parse scan.mjs stdout.
 * New offers are printed as "  + Company | Title | Location"
 * Errors as           "  ✗ Company: message"
 */
function parseScanOutput(stdout) {
  const lines = stdout.split("\n");
  const newOffers = lines.filter((l) => /^\s+\+\s+/.test(l)).length;
  const errors = lines.filter((l) => /^\s+✗\s+/.test(l)).length;
  return { newOffers, errors };
}

// ── CV stage ───────────────────────────────────────────────────────────────────

/**
 * Best-effort: if a rendered cv.html exists (e.g. placed by the AI agent or a
 * previous run), convert it to a dated PDF via generate-pdf.mjs.
 * Returns the output path, or null if skipped.
 */
async function generateStandardCv() {
  const candidates = ["output/cv.html", "templates/cv-template.html"];
  const inputHtml = candidates.find((p) => existsSync(p));

  if (!inputHtml) {
    log(
      "  ⚠️  CV stage: no cv.html found in output/ or templates/ — skipping PDF render",
    );
    log(
      "     Tip: let the AI agent generate a tailored cv.html first (pdf mode)",
    );
    return null;
  }

  const date = todayISO();
  const outputPdf = `output/cv-${date}.pdf`;

  if (existsSync(outputPdf)) {
    log(`  📄 CV stage: ${outputPdf} already exists — skipping`);
    return outputPdf;
  }

  log(`  📄 CV stage: rendering ${inputHtml} → ${outputPdf}`);
  const result = await runProcess("node", [
    "generate-pdf.mjs",
    inputHtml,
    outputPdf,
  ]);
  if (result.code !== 0) {
    log(`  ⚠️  CV stage: generate-pdf.mjs exited with code ${result.code}`);
    return null;
  }
  log(`  ✅ CV stage: ${outputPdf} generated`);
  return outputPdf;
}

// ── Pending review helpers ─────────────────────────────────────────────────────

function loadTelegramState() {
  if (!existsSync(TG_STATE_PATH))
    return { kept: [], skipped: [], pendingCards: {} };
  try {
    return JSON.parse(readFileSync(TG_STATE_PATH, "utf-8"));
  } catch {
    return { kept: [], skipped: [], pendingCards: {} };
  }
}

function pendingReviewCount() {
  return Object.keys(loadTelegramState().pendingCards).length;
}

/**
 * Return up to `limit` pending job cards as formatted strings.
 */
function pendingReviewList(limit = 10) {
  const cards = loadTelegramState().pendingCards;
  return Object.values(cards)
    .slice(0, limit)
    .map((c) => `${c.company ?? "?"} — ${c.title ?? "?"}`);
}

// ── Telegram one-shot sender ───────────────────────────────────────────────────

async function sendTg(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const bot = new TelegramBot(token, { polling: false });
    await bot.sendMessage(chatId, text, { parse_mode: "HTML", ...opts });
  } catch (err) {
    log(`⚠️  Telegram send error: ${err.message}`);
  }
}

// ── Daily summary ──────────────────────────────────────────────────────────────

async function sendDailySummary(state) {
  const s = state.today;
  const pending = pendingReviewCount();
  const text = [
    "📅 <b>Daily Summary</b>",
    "",
    `🔍 Scan cycles run: <b>${s.scanCycles}</b>`,
    `✨ New offers found: <b>${s.newOffers}</b>`,
    `📄 CVs generated:   <b>${s.cvsGenerated}</b>`,
    `⏳ Pending review:  <b>${pending}</b>`,
    s.errors > 0 ? `⚠️  Scan errors: ${s.errors}` : "",
    "",
    state.paused
      ? "⏸ Scheduler is <b>paused</b> — send /resume to continue"
      : "▶️ Scheduler running",
  ]
    .filter((l) => l !== "")
    .join("\n");

  await sendTg(text);
  log("📅 Daily summary sent via Telegram");
}

function isDailySummaryDue(state, config) {
  if (state.dailySummarySentDate === todayISO()) return false;
  const { hours, minutes } = parseHHMM(config.daily_summary_time || "20:00");
  const now = new Date();
  return now.getHours() === hours && now.getMinutes() >= minutes;
}

// ── /usage — Claude Code subscription check ────────────────────────────────────

async function fetchClaudeUsage() {
  try {
    // claude /status prints rate-limit fields when a session is active
    const result = await runProcess("claude", ["/status"], { timeout: 20_000 });

    if (result.code !== 0 || !result.stdout.trim()) {
      return "⚠️ No active Claude session or <code>claude</code> not on PATH.\nCannot fetch usage right now.";
    }

    const out = result.stdout;

    // Try to surface the used_percentage and reset_at lines for 5h and 7d windows
    const relevant = out
      .split("\n")
      .filter((l) =>
        /used_percentage|reset_at|rate_limit|5.hour|7.day|window/i.test(l),
      );

    if (relevant.length > 0) {
      return `<b>Claude usage</b>\n<code>${relevant.slice(0, 12).join("\n")}</code>`;
    }

    // Fall back: return first 600 chars of raw output
    return `<b>Claude /status output</b>\n<code>${out.slice(0, 600).trim()}</code>`;
  } catch (err) {
    return `⚠️ Usage check failed: ${err.message.slice(0, 200)}`;
  }
}

// ── Disk usage helpers ─────────────────────────────────────────────────────────

const DISK_LIMIT_MB = 500;

/** Recursively sum file sizes in `dir`, return total in MB (0 if dir missing). */
function getOutputDirSizeMb() {
  let bytes = 0;
  try {
    if (!existsSync(OUTPUT_DIR)) return 0;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) bytes += statSync(full).size;
      }
    };
    walk(OUTPUT_DIR);
  } catch {
    /* ignore */
  }
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Check output/ disk usage. Sends a Telegram warning once per calendar day
 * if the directory exceeds DISK_LIMIT_MB. Mutates state.diskWarnedDate.
 */
async function checkDiskUsage(state) {
  const mb = getOutputDirSizeMb();
  if (mb > DISK_LIMIT_MB && state.diskWarnedDate !== todayISO()) {
    state.diskWarnedDate = todayISO();
    log(`⚠️  output/ is ${mb} MB — exceeds ${DISK_LIMIT_MB} MB limit`);
    await sendTg(
      `⚠️ <b>Disk usage warning</b>\n\n` +
        `<code>output/</code> is <b>${mb} MB</b> (limit: ${DISK_LIMIT_MB} MB).\n` +
        `Consider archiving or deleting old PDFs.\n` +
        `List large files: <code>ls -lhS output/</code>`,
    );
  }
  return mb;
}

// ── Main scan cycle ────────────────────────────────────────────────────────────

/**
 * Run one full scan cycle:
 *   1. node scan.mjs [--notify] [--verify]
 *   2. CV stage (if enabled)
 *   3. Update daily stats
 *   4. Enforce daily limit
 *
 * @param {object} config
 * @param {object} state   — mutated in place, caller must saveState()
 * @returns {object} updated state
 */
async function runScanCycle(config, state) {
  state = resetDailyIfNeeded(state);
  state.today.scanCycles += 1;

  log(`🔍 Scan cycle #${state.today.scanCycles} starting`);

  // Pre-flight: disk usage check
  await checkDiskUsage(state);

  // ── Stage: scan ─────────────────────────────────────────────────────────────
  if (config.enabled_stages.includes("scan")) {
    const scanArgs = ["scan.mjs"];
    if (config.enabled_stages.includes("notify")) scanArgs.push("--notify");
    if (config.verify_liveness) scanArgs.push("--verify");

    let scanResult;
    let scanFailed = false;

    try {
      scanResult = await runProcess("node", scanArgs);
    } catch (err) {
      log(`❌ Scan process failed to start: ${err.message}`);
      await sendTg(`❌ <b>Scan failed to start</b>\n${escHtml(err.message)}`);
      state.today.errors += 1;
      scanFailed = true;
      scanResult = { code: 1, stdout: "", stderr: err.message };
    }

    if (!scanFailed && scanResult.code !== 0) {
      log(`⚠️  scan.mjs exited with code ${scanResult.code}`);
      state.today.errors += 1;
      scanFailed = true;
    }

    // ── Circuit breaker ────────────────────────────────────────────────────
    if (scanFailed) {
      state.consecutiveScanFailures = (state.consecutiveScanFailures || 0) + 1;
      log(`⚠️  Consecutive scan failures: ${state.consecutiveScanFailures}/3`);

      if (state.consecutiveScanFailures >= 3) {
        // Open the circuit — stop auto-retrying until user sends /resume
        if (!state.circuitOpen) {
          state.circuitOpen = true;
          state.paused = true;
          log("🔴 Circuit breaker OPEN — scheduler paused until /resume");
          await sendTg(
            "🔴 <b>Circuit breaker triggered</b>\n\n" +
              "3 consecutive scan failures detected. Possible causes:\n" +
              "• Playwright / Chromium crash (memory exhaustion on RPi)\n" +
              "• Network outage\n" +
              "• Configuration error\n\n" +
              "Scheduler is <b>paused</b>. Check logs, then send /resume to reset.",
          );
        }
      } else {
        // Schedule an automatic retry in 5 minutes (transient crash recovery)
        const retryDate = new Date(Date.now() + 5 * 60 * 1000);
        state.retryAt = retryDate.toISOString();
        log(
          `🔄 Auto-retry scheduled for ${retryDate.toLocaleTimeString()} (attempt ${state.consecutiveScanFailures}/3)`,
        );
      }
    } else {
      // Success — reset circuit breaker
      if (state.consecutiveScanFailures > 0) {
        log(
          `✅ Scan succeeded — resetting circuit breaker (was at ${state.consecutiveScanFailures})`,
        );
      }
      state.consecutiveScanFailures = 0;
      state.circuitOpen = false;
      state.retryAt = null;
    }

    if (!scanFailed) {
      const { newOffers, errors } = parseScanOutput(scanResult.stdout);
      state.today.newOffers += newOffers;
      state.today.errors += errors;
      state.lastScanTime = new Date().toISOString();

      log(`✅ Scan complete — ${newOffers} new offer(s), ${errors} error(s)`);

      // Score-threshold note: scores are only available after AI evaluation.
      // The threshold (${config.score_threshold}) applies when you run /career-ops pipeline.
      if (newOffers > 0) {
        log(
          `   Score threshold ${config.score_threshold} — apply AI evaluation (/career-ops pipeline) to filter further`,
        );
      }
    }
  }

  // ── Stage: cv ──────────────────────────────────────────────────────────────
  if (config.enabled_stages.includes("cv") && state.today.newOffers > 0) {
    const cvPath = await generateStandardCv();
    if (cvPath) state.today.cvsGenerated += 1;
  }

  // ── Safety limit ────────────────────────────────────────────────────────────
  if (
    state.today.newOffers >= config.max_applications_per_day &&
    !state.paused
  ) {
    state.paused = true;
    log(
      `⛔ Daily limit reached (${config.max_applications_per_day}) — scheduler paused`,
    );
    await sendTg(
      `⛔ <b>Daily limit reached</b>\n\n` +
        `${state.today.newOffers} jobs passed the scanner filter today ` +
        `(limit: ${config.max_applications_per_day}).\n\n` +
        `Scheduler is <b>paused</b>. Send /resume to continue.`,
    );
  }

  saveState(state);
  return state;
}

// ── HTML escaping for Telegram HTML mode ───────────────────────────────────────

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Telegram command listener ──────────────────────────────────────────────────

/**
 * Start the Telegram polling listener.
 * @param {object} ctx  — shared mutable context: { state, config, triggerScan }
 * @returns {TelegramBot|null}
 */
function startCommandListener(ctx) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    log(
      "ℹ️  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — command listener disabled",
    );
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  log("📱 Telegram command listener active");

  /** Wrap handlers: auth-guard + error reporter */
  const cmd = (handler) => async (msg) => {
    if (String(msg.chat?.id) !== String(chatId)) return;
    try {
      await handler(msg);
    } catch (err) {
      log(`⚠️  Command handler error: ${err.message}`);
      await bot.sendMessage(chatId, `⚠️ Error: ${escHtml(err.message)}`, {
        parse_mode: "HTML",
      });
    }
  };

  // /status
  bot.onText(
    /\/status/,
    cmd(async () => {
      const { state, config } = ctx;
      const nextScan = state.nextScanTime
        ? new Date(state.nextScanTime).toLocaleString()
        : "unknown";
      const lastScan = state.lastScanTime
        ? new Date(state.lastScanTime).toLocaleString()
        : "never";
      const pending = pendingReviewCount();

      const circuitLine = state.circuitOpen
        ? `🔴 Circuit:   OPEN (${state.consecutiveScanFailures} failures) — send /resume`
        : state.consecutiveScanFailures > 0
          ? `🟡 Circuit:   ${state.consecutiveScanFailures}/3 failures`
          : "";
      const retryLine = state.retryAt
        ? `🔄 Auto-retry: ${new Date(state.retryAt).toLocaleTimeString()}`
        : "";

      await bot.sendMessage(
        chatId,
        [
          "📊 <b>Scheduler Status</b>",
          "",
          `Status:     ${state.paused ? "⏸ Paused" : "▶️ Running"}`,
          circuitLine,
          retryLine,
          `Last scan:  ${lastScan}`,
          `Next scan:  ${nextScan}`,
          "",
          "<b>Today</b>",
          `🔁 Cycles run:    ${state.today.scanCycles}`,
          `✨ New offers:    ${state.today.newOffers}`,
          `📄 CVs generated: ${state.today.cvsGenerated}`,
          `⏳ Pending review: ${pending}`,
          `⚠️  Errors:        ${state.today.errors}`,
          `🚦 Daily limit:   ${config.max_applications_per_day}`,
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML" },
      );
    }),
  );

  // /scan — trigger immediate scan
  bot.onText(
    /\/scan(?:\s|$)/,
    cmd(async () => {
      if (ctx.state.paused) {
        await bot.sendMessage(
          chatId,
          "⏸ Scheduler is paused.\nSend /resume first, then /scan.",
          { parse_mode: "HTML" },
        );
        return;
      }
      await bot.sendMessage(chatId, "🔍 Scan queued — starting shortly...", {
        parse_mode: "HTML",
      });
      log("📱 /scan command received — flagging immediate scan");
      ctx.triggerScan();
    }),
  );

  // /pause and /stop
  bot.onText(
    /\/(pause|stop)(?:\s|$)/,
    cmd(async () => {
      ctx.state.paused = true;
      saveState(ctx.state);
      log("📱 /pause — scheduler paused via Telegram");
      await bot.sendMessage(
        chatId,
        "⏸ Auto-scanning paused.\nSend /resume (or /start) to continue.",
        { parse_mode: "HTML" },
      );
    }),
  );

  // /resume and /start
  bot.onText(
    /\/(resume|start)(?:\s|$)/,
    cmd(async () => {
      const wasCircuitOpen = ctx.state.circuitOpen;
      ctx.state.paused = false;
      ctx.state.circuitOpen = false;
      ctx.state.consecutiveScanFailures = 0;
      ctx.state.retryAt = null;
      saveState(ctx.state);
      log("📱 /resume — scheduler resumed via Telegram");
      const msg = wasCircuitOpen
        ? "▶️ Scheduler resumed. Circuit breaker reset — scanning will restart at the next scheduled time."
        : "▶️ Scheduler resumed.";
      await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
    }),
  );

  // /pending
  bot.onText(
    /\/pending(?:\s|$)/,
    cmd(async () => {
      const list = pendingReviewList(15);
      if (list.length === 0) {
        await bot.sendMessage(
          chatId,
          "✅ No jobs pending your review.\n(All Telegram cards have been acted on.)",
          { parse_mode: "HTML" },
        );
        return;
      }
      const items = list.map((l, i) => `${i + 1}. ${escHtml(l)}`).join("\n");
      await bot.sendMessage(
        chatId,
        `⏳ <b>Pending Review (${list.length})</b>\n\n${items}`,
        { parse_mode: "HTML" },
      );
    }),
  );

  // /usage
  bot.onText(
    /\/usage(?:\s|$)/,
    cmd(async () => {
      await bot.sendMessage(chatId, "⏳ Checking Claude usage…", {
        parse_mode: "HTML",
      });
      const usage = await fetchClaudeUsage();
      await bot.sendMessage(chatId, usage, { parse_mode: "HTML" });
    }),
  );

  bot.on("polling_error", (err) => {
    log(`⚠️  Telegram polling error: ${err.code ?? ""} ${err.message}`);
  });

  return bot;
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isOnce = args.includes("--once");
  const isDaemon = args.includes("--daemon");

  if (!isOnce && !isDaemon) {
    console.error(
      [
        "career-ops autonomous scheduler",
        "",
        "Usage:",
        "  node scheduler.mjs --once    # one full scan cycle, then exit",
        "  node scheduler.mjs --daemon  # run continuously on configured schedule",
      ].join("\n"),
    );
    process.exit(1);
  }

  const config = loadConfig();
  let state = loadState();

  log("═══════════════════════════════════════════════════════════");
  log(`🤖 career-ops scheduler — mode: ${isOnce ? "once" : "daemon"}`);
  log(`   Config:        ${CONFIG_PATH}`);
  log(
    `   Scan times:    ${(config.scan_times ?? []).join(", ") || `every ${config.scan_interval_hours}h`}`,
  );
  log(`   Score gate:    ${config.score_threshold}`);
  log(`   Daily limit:   ${config.max_applications_per_day}`);
  log(`   Stages:        ${config.enabled_stages.join(", ")}`);
  log(`   Verify liveness: ${config.verify_liveness}`);
  log("═══════════════════════════════════════════════════════════");

  // ── --once mode ────────────────────────────────────────────────────────────
  if (isOnce) {
    state = resetDailyIfNeeded(state);
    state = await runScanCycle(config, state);
    log("✅ --once cycle complete");
    log(`   New offers today: ${state.today.newOffers}`);
    log(`   CVs generated:    ${state.today.cvsGenerated}`);
    log(`   Errors:           ${state.today.errors}`);
    process.exit(state.today.errors > 0 ? 1 : 0);
  }

  // ── --daemon mode ──────────────────────────────────────────────────────────

  // Shared mutable context for command listener callbacks
  const ctx = {
    state,
    config,
    triggerScan: () => {
      ctx._scanPending = true;
    },
    _scanPending: false,
  };

  // Start Telegram command listener
  const bot = startCommandListener(ctx);

  // Compute first next-scan timestamp
  state = resetDailyIfNeeded(state);
  state.nextScanTime = computeNextScanTime(config).toISOString();
  saveState(state);
  ctx.state = state;

  log(
    `⏰ First scan scheduled for: ${new Date(state.nextScanTime).toLocaleString()}`,
  );

  await sendTg(
    [
      "🤖 <b>career-ops scheduler started</b>",
      "",
      `Scan times: ${(config.scan_times ?? []).join(", ") || `every ${config.scan_interval_hours}h`}`,
      `Daily limit: ${config.max_applications_per_day}`,
      `Liveness check: ${config.verify_liveness ? "on" : "off"}`,
      "",
      "Commands: /status /scan /pause /resume /stop /start /pending /usage",
    ].join("\n"),
  );

  // Graceful shutdown
  let shouldExit = false;
  const onShutdown = async () => {
    if (shouldExit) return;
    shouldExit = true;
    log("👋 Shutdown signal received — stopping scheduler");
    if (bot) bot.stopPolling();
    await sendTg("👋 career-ops scheduler stopped.");
  };
  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);

  // Main loop — tick every 30 s
  while (!shouldExit) {
    // Sync ctx.state back from any command-handler mutations
    state = ctx.state;
    state = resetDailyIfNeeded(state);
    ctx.state = state;

    const now = new Date();
    const nextScan = new Date(state.nextScanTime);
    const retryDue =
      !state.circuitOpen && !!state.retryAt && now >= new Date(state.retryAt);
    const scanDue =
      !state.paused &&
      !state.circuitOpen &&
      (now >= nextScan || ctx._scanPending || retryDue);

    if (scanDue) {
      ctx._scanPending = false;
      state.retryAt = null; // clear any pending retry before the cycle sets a new one

      state = await runScanCycle(config, state);
      ctx.state = state;

      // Advance to next scheduled slot
      state.nextScanTime = computeNextScanTime(config).toISOString();
      saveState(state);
      ctx.state = state;

      log(
        `⏰ Next scan scheduled for: ${new Date(state.nextScanTime).toLocaleString()}`,
      );
    }

    // Daily summary
    if (isDailySummaryDue(state, config)) {
      await sendDailySummary(state);
      state.dailySummarySentDate = todayISO();
      saveState(state);
      ctx.state = state;
    }

    await sleep(30_000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
