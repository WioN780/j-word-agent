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
import { pathToFileURL, fileURLToPath } from "url";
import path from "path";
import yaml from "js-yaml";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { detectATS } from "./ats-detector.mjs";

dotenv.config();

const ROOT = path.dirname(fileURLToPath(import.meta.url));

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
  evalResults: [],      // [{url, company, role, score, reportPath}]
  highScoringJobs: [],  // subset of evalResults that passed score_threshold
  morningDigestSent: false,
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
    // Score threshold mirror (set from config at cycle start)
    scoreThreshold: 3.5,
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

function isMorningDigestDue(state, config) {
  const time = config.morning_digest_time || "";
  if (!time) return false;
  if (state.today.morningDigestSent) return false;
  if ((state.today.evalResults || []).length === 0) return false;
  const { hours, minutes } = parseHHMM(time);
  const now = new Date();
  return now.getHours() === hours && now.getMinutes() >= minutes;
}

// ── Telegram helpers (send + edit) ────────────────────────────────────────────

/**
 * Send a Telegram message and return the full message object (including message_id).
 * Returns null when credentials are missing.
 */
async function sendTgMsg(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  try {
    const bot = new TelegramBot(token, { polling: false });
    return await bot.sendMessage(chatId, text, { parse_mode: "HTML", disable_web_page_preview: true, ...opts });
  } catch (err) {
    log(`⚠️  Telegram sendTgMsg error: ${err.message}`);
    return null;
  }
}

/**
 * Edit an existing Telegram message in-place.
 * Silent no-op when credentials are missing or the message is too old to edit.
 */
async function editTg(msgId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !msgId) return;
  try {
    const bot = new TelegramBot(token, { polling: false });
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch {
    /* too old, not modified, or rate-limited — safe to ignore */
  }
}

// ── Pipeline URL reader ───────────────────────────────────────────────────────

/** Parse all unchecked URLs from data/pipeline.md → Set<string> */
function readPipelineUrls() {
  if (!existsSync(PIPELINE_PATH)) return new Set();
  const lines = readFileSync(PIPELINE_PATH, "utf-8").split("\n");
  const urls = new Set();
  for (const line of lines) {
    const m = line.match(/^- \[ \] (\S+)/);
    if (m) urls.add(m[1]);
  }
  return urls;
}

// ── HTML → plain text ─────────────────────────────────────────────────────────

function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Fetch JD text from ATS public API ────────────────────────────────────────

/**
 * Fetch the job description text for a given ATS URL.
 * Supports Greenhouse, Lever, and Ashby.
 * Returns plain text, or null if the ATS is unsupported.
 */
async function fetchJdText(url) {
  try {
    // Greenhouse: boards.greenhouse.io/{co}/jobs/{id} or job-boards.greenhouse.io/{co}/jobs/{id}
    const ghMatch = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
    if (ghMatch) {
      const [, co, id] = ghMatch;
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${co}/jobs/${id}`);
      if (!res.ok) return null;
      const data = await res.json();
      return htmlToText(data.content || data.description || "");
    }

    // Lever: jobs.lever.co/{co}/{uuid}
    const leverMatch = url.match(/lever\.co\/([^/?#]+)\/([a-f0-9-]{36})/i);
    if (leverMatch) {
      const [, co, id] = leverMatch;
      const res = await fetch(`https://api.lever.co/v0/postings/${co}/${id}`);
      if (!res.ok) return null;
      const data = await res.json();
      const d = data.text || data;
      return htmlToText((d.description || "") + "\n" + (d.descriptionBody || ""));
    }

    // Ashby: jobs.ashbyhq.com/{co}/{uuid}
    const ashbyMatch = url.match(/ashbyhq\.com\/([^/?#]+)\/([a-f0-9-]{36})/i);
    if (ashbyMatch) {
      const [, , id] = ashbyMatch;
      const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationName: "ApiJobPosting",
          variables: { jobPostingId: id },
          query: "query ApiJobPosting($jobPostingId: String!) { jobPosting(jobPostingId: $jobPostingId) { title descriptionHtml } }",
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return htmlToText(data?.data?.jobPosting?.descriptionHtml || "");
    }
  } catch (err) {
    log(`⚠️  fetchJdText(${url}): ${err.message}`);
  }
  return null;
}

// ── Website context (projects + live CV PDF) ─────────────────────────────────

/**
 * Fetch live portfolio data from markooba.com/api.
 * Returns { projectsMd, cvPdfPath, resolvedUrl } — both cached for the duration of the cycle.
 */
async function fetchWebsiteContext() {
  const cvPdfPath = path.join(ROOT, "output", "cv-live.pdf");
  let projectsMd = "";
  let resolvedUrl = "https://markooba.com/api/projects.json";

  let lang = "en"; // default language
  try {
    const profilePath = path.join(ROOT, "config", "profile.yml");
    if (existsSync(profilePath)) {
      const profile = yaml.load(readFileSync(profilePath, "utf-8")) || {};
      if (profile.language) {
        lang = String(profile.language).trim();
      } else if (profile.lang) {
        lang = String(profile.lang).trim();
      } else if (profile.candidate?.language) {
        lang = String(profile.candidate.language).trim();
      } else if (profile.candidate?.lang) {
        lang = String(profile.candidate.lang).trim();
      } else if (profile.language?.modes_dir) {
        const match = profile.language.modes_dir.match(/modes\/([a-z]{2})/);
        if (match) lang = match[1];
      }
    }
  } catch (err) {
    log(`  ⚠️  Failed to load profile.yml for language check: ${err.message}`);
  }

  lang = lang.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!lang) lang = "en";

  try {
    const targetUrl = `https://markooba.com/api/${lang}/projects.json`;
    log(`  🌐 Fetching projects from: ${targetUrl}`);
    let res = await fetch(targetUrl);
    if (!res.ok) {
      log(`  ⚠️  Failed to fetch ${targetUrl} (Status ${res.status}). Falling back to legacy API...`);
      res = await fetch("https://markooba.com/api/projects.json");
    }

    if (res.ok) {
      resolvedUrl = res.url || targetUrl;
      let projects = await res.json();
      if (!Array.isArray(projects)) {
        if (projects && typeof projects === "object") {
          if (Array.isArray(projects.projects)) {
            projects = projects.projects;
          } else {
            projects = [projects];
          }
        } else {
          projects = [];
        }
      }

      // Filter by language if projects contain mixed languages
      if (projects.some(p => p.lang)) {
        projects = projects.filter(p => p.lang === lang);
      }

      const lines = [`## Live Portfolio Projects (from markooba.com - ${lang.toUpperCase()})`, ""];
      for (const p of projects.slice(0, 12)) {
        lines.push(`### ${p.title}`);
        if (p.description) lines.push(p.description);
        if (p.tags?.length) lines.push(`Tags: ${p.tags.join(", ")}`);
        const bodyText = p.body || p.markdown;
        if (bodyText) lines.push("", bodyText.slice(0, 800));
        lines.push("");
      }
      projectsMd = lines.join("\n");
      log(`  🌐 Fetched ${projects.length} projects from portfolio API`);
    }
  } catch (err) {
    log(`  ⚠️  Portfolio fetch failed: ${err.message}`);
  }

  try {
    mkdirSync(path.join(ROOT, "output"), { recursive: true });
    const targetCvUrl = `https://markooba.com/api/${lang}/cv.pdf`;
    log(`  🌐 Downloading CV PDF from: ${targetCvUrl}`);
    let res = await fetch(targetCvUrl);
    if (!res.ok) {
      log(`  ⚠️  Failed to fetch CV from ${targetCvUrl} (Status ${res.status}). Trying fallback...`);
      res = await fetch("https://markooba.com/api/cv/en.pdf");
      if (!res.ok) {
        res = await fetch("https://markooba.com/api/cv.pdf");
      }
    }

    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(cvPdfPath, buf);
      log(`  🌐 Downloaded live CV PDF → output/cv-live.pdf (${Math.round(buf.length / 1024)} KB)`);
    }
  } catch (err) {
    log(`  ⚠️  CV PDF fetch failed: ${err.message}`);
  }

  return { projectsMd, cvPdfPath: existsSync(cvPdfPath) ? cvPdfPath : null, resolvedUrl };
}

// ── Eval context loader (mode files + CV, read once per cycle) ───────────────

function loadEvalContext(projectsMd = "", resolvedUrl = "markooba.com/api/projects.json") {
  const readSafe = (p) => {
    const full = path.join(ROOT, p);
    return existsSync(full) ? readFileSync(full, "utf-8").trim() : `[${p} not found]`;
  };
  return [
    "═══════════════════════════════════════════════════════",
    "SYSTEM CONTEXT (_shared.md)",
    "═══════════════════════════════════════════════════════",
    readSafe("modes/_shared.md"),
    "",
    "═══════════════════════════════════════════════════════",
    "EVALUATION MODE (oferta.md)",
    "═══════════════════════════════════════════════════════",
    readSafe("modes/oferta.md"),
    "",
    "═══════════════════════════════════════════════════════",
    "CANDIDATE RESUME (cv.md)",
    "═══════════════════════════════════════════════════════",
    readSafe("cv.md"),
    "",
    "═══════════════════════════════════════════════════════",
    "CANDIDATE PROFILE (config/profile.yml)",
    "═══════════════════════════════════════════════════════",
    readSafe("config/profile.yml"),
    "",
    "═══════════════════════════════════════════════════════",
    "USER ARCHETYPES & NARRATIVE (_profile.md)",
    "═══════════════════════════════════════════════════════",
    readSafe("modes/_profile.md"),
    ...(projectsMd ? [
      "",
      "═══════════════════════════════════════════════════════",
      `LIVE PORTFOLIO (${resolvedUrl})`,
      "═══════════════════════════════════════════════════════",
      projectsMd,
    ] : []),
  ].join("\n");
}

// ── Gemini evaluation stage ───────────────────────────────────────────────────

/**
 * Score new job URLs with Gemini.
 * @param {string[]} urls
 * @param {object} websiteCtx  { projectsMd, cvPdfPath }
 * @param {function} updateCb  (i, total, company) — called to edit the status message
 * @returns {Array<{url, company, role, score, reportPath}>}
 */
async function evalNewJobs(urls, websiteCtx, updateCb) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log("⚠️  eval stage: GEMINI_API_KEY not set — skipping");
    return [];
  }

  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
  });

  const systemContext = loadEvalContext(websiteCtx.projectsMd, websiteCtx.resolvedUrl);
  const results = [];
  const today = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    log(`  🤖 Evaluating (${i + 1}/${urls.length}): ${url}`);

    // Fetch JD text
    const jdText = await fetchJdText(url);
    if (!jdText) {
      log(`  ⚠️  Could not fetch JD for ${url} — skipping`);
      continue;
    }

    // Notify via edited Telegram message
    const previewCompany = url.split("/").slice(-3, -2)[0] || "job";
    await updateCb(i + 1, urls.length, previewCompany);

    // Call Gemini
    let evalText;
    try {
      const result = await model.generateContent([
        { text: systemContext + "\n\nIMPORTANT: You do NOT have WebSearch or file-writing tools. Output Blocks A–G then the SCORE_SUMMARY machine block.\n\n---SCORE_SUMMARY--- format required at end." },
        { text: `JOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
      ]);
      evalText = result.response.text();
    } catch (err) {
      log(`  ⚠️  Gemini error for ${url}: ${err.message}`);
      continue;
    }

    // Parse score summary
    const summaryMatch = evalText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
    if (!summaryMatch) {
      log(`  ⚠️  No SCORE_SUMMARY in Gemini output for ${url}`);
      continue;
    }

    const extract = (key) => {
      const m = summaryMatch[1].match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "mi"));
      return m?.[1]?.trim() || "unknown";
    };
    const company = extract("COMPANY");
    const role = extract("ROLE");
    const scoreStr = extract("SCORE");
    const archetype = extract("ARCHETYPE");
    const legitimacy = extract("LEGITIMACY");
    const score = parseFloat(scoreStr);

    if (!isFinite(score)) {
      log(`  ⚠️  Invalid score for ${url}: "${scoreStr}"`);
      continue;
    }

    // Save report
    mkdirSync(path.join(ROOT, "reports"), { recursive: true });
    const existingNums = existsSync(path.join(ROOT, "reports"))
      ? readdirSync(path.join(ROOT, "reports")).filter(f => /^\d{3}-/.test(f)).map(f => parseInt(f)).filter(n => !isNaN(n))
      : [];
    const num = String((existingNums.length ? Math.max(...existingNums) : 0) + 1).padStart(3, "0");
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
    const filename = `${num}-${slug}-${today}.md`;
    const reportPath = path.join(ROOT, "reports", filename);

    const reportContent = [
      `# Evaluation: ${company} — ${role}`,
      "",
      `**Date:** ${today}`,
      `**Archetype:** ${archetype}`,
      `**Score:** ${score}/5`,
      `**URL:** ${url}`,
      `**Legitimacy:** ${legitimacy}`,
      `**PDF:** pending`,
      `**Tool:** Gemini (${modelName}) via scheduler`,
      "",
      "---",
      "",
      evalText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, "").trim(),
    ].join("\n");

    writeFileSync(reportPath, reportContent, "utf-8");

    // Save TSV for tracker merge
    mkdirSync(path.join(ROOT, "batch", "tracker-additions"), { recursive: true });
    const tsvPath = path.join(ROOT, "batch", "tracker-additions", `${num}-${slug}.tsv`);
    const tsvRow = [
      String(parseInt(num, 10)), today, company, role, "Evaluated",
      `${score}/5`, "❌", `[${num}](reports/${filename})`, "Auto-eval via scheduler",
    ].join("\t");
    writeFileSync(tsvPath, tsvRow + "\n", "utf-8");

    log(`  ✅ ${company} — ${role}: ${score}/5 → reports/${filename}`);
    results.push({ url, company, role, score, reportPath: `reports/${filename}` });
  }

  // Merge tracker additions
  if (results.length > 0) {
    await runProcess("node", ["merge-tracker.mjs"]).catch(() => {});
  }

  return results;
}

// ── Claude doc generation stage ───────────────────────────────────────────────

/**
 * Generate tailored CV + cover letter for a high-scoring job using claude -p.
 * @param {{url, company, role, score}} job
 * @param {object} websiteCtx  { projectsMd, cvPdfPath }
 * @returns {{cvHtmlPath, cvPdfPath, applyCardPath}|null}
 */
async function prepareDocsForJob(job, websiteCtx) {
  const readSafe = (p) => {
    const full = path.join(ROOT, p);
    return existsSync(full) ? readFileSync(full, "utf-8").trim() : "";
  };

  const slug = job.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const cvHtmlPath = path.join(ROOT, "output", `cv-${slug}-${today}.html`);
  const cvOutPdf = path.join(ROOT, "output", `cv-${slug}-${today}.pdf`);

  mkdirSync(path.join(ROOT, "output"), { recursive: true });

  // Fetch JD
  const jdText = await fetchJdText(job.url);
  if (!jdText) {
    log(`  ⚠️  docs stage: could not fetch JD for ${job.url}`);
    return null;
  }

  const pdfMode = readSafe("modes/pdf.md");
  const cvMd = readSafe("cv.md");
  const template = readSafe("templates/cv-template.html");

  const prompt = [
    "You are a CV generation assistant using the career-ops system.",
    "Follow the instructions below EXACTLY. Output ONLY the final HTML — no markdown fences, no explanations.",
    "",
    "═══ CV GENERATION INSTRUCTIONS (modes/pdf.md) ═══",
    pdfMode,
    "",
    "═══ HTML TEMPLATE (cv-template.html) ═══",
    template,
    "",
    "═══ CANDIDATE CV (cv.md) ═══",
    cvMd,
    ...(websiteCtx.projectsMd ? [
      "",
      "═══ LIVE PORTFOLIO PROJECTS ═══",
      websiteCtx.projectsMd,
    ] : []),
    "",
    "═══ JOB DESCRIPTION ═══",
    `Company: ${job.company}`,
    `Role: ${job.role}`,
    "",
    jdText,
    "",
    "Now generate the tailored CV HTML. Output ONLY the HTML document, starting with <!DOCTYPE html>.",
  ].join("\n");

  log(`  🤖 docs stage: generating tailored CV for ${job.company} — ${job.role}`);
  const result = await runProcess("claude", ["-p", prompt], { timeout: 180_000 });

  if (result.code !== 0) {
    log(`  ⚠️  claude -p exited with code ${result.code}`);
    return null;
  }

  // Extract HTML from stdout (claude may wrap in markdown fences)
  let html = result.stdout.trim();
  const fenceMatch = html.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (fenceMatch) html = fenceMatch[1].trim();
  if (!html.includes("<!DOCTYPE") && !html.includes("<html")) {
    log("  ⚠️  claude output doesn't look like HTML — skipping");
    return null;
  }

  writeFileSync(cvHtmlPath, html, "utf-8");
  log(`  📄 docs stage: CV HTML → output/cv-${slug}-${today}.html`);

  // Render to PDF
  const pdfResult = await runProcess("node", ["generate-pdf.mjs", cvHtmlPath, cvOutPdf]);
  if (pdfResult.code !== 0) {
    log(`  ⚠️  generate-pdf.mjs failed for ${slug}`);
  } else {
    log(`  📄 docs stage: PDF → output/cv-${slug}-${today}.pdf`);
  }

  // Generate apply card (form answers)
  let applyCardPath = null;
  try {
    const { generateAndSaveApplyCard } = await import("./apply-card.mjs");
    const { filePath } = generateAndSaveApplyCard({
      url: job.url,
      title: job.role,
      company: job.company,
    });
    applyCardPath = filePath;
    log(`  📋 docs stage: apply card → ${filePath}`);
  } catch (err) {
    log(`  ⚠️  apply-card generation failed: ${err.message}`);
  }

  return {
    cvHtmlPath,
    cvPdfPath: existsSync(cvOutPdf) ? cvOutPdf : (websiteCtx.cvPdfPath || null),
    applyCardPath,
  };
}

// ── Morning digest ────────────────────────────────────────────────────────────

/**
 * Send a ranked Telegram digest of today's evaluated jobs.
 * Each high-scoring job gets its own message with inline action buttons.
 */
async function sendMorningDigest(state) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const results = (state.today.evalResults || []).slice().sort((a, b) => b.score - a.score);
  if (results.length === 0) return;

  const bot = new TelegramBot(token, { polling: false });
  const high = results.filter(r => r.score >= (state.scoreThreshold || 3.5));

  // Header message
  await bot.sendMessage(chatId, [
    "🌅 <b>Morning Job Digest</b>",
    "",
    `📊 Evaluated: <b>${results.length}</b> jobs`,
    `⭐ Above threshold: <b>${high.length}</b>`,
    `📋 Docs prepared: <b>${state.today.highScoringJobs?.length || 0}</b>`,
    "",
    "Ranked by score ↓",
  ].join("\n"), { parse_mode: "HTML" });

  // One card per result
  for (const job of results.slice(0, 20)) {
    const scoreBar = "⭐".repeat(Math.round(job.score)) + "☆".repeat(Math.max(0, 5 - Math.round(job.score)));
    const card = [
      `${scoreBar} <b>${escHtml(job.company)}</b> — ${escHtml(job.role)}`,
      `Score: <b>${job.score}/5</b>`,
      job.reportPath ? `📄 <a href="${escHtml(job.url)}">Job posting</a> · <code>${escHtml(job.reportPath)}</code>` : `🔗 ${escHtml(job.url)}`,
    ].join("\n");

    const buttons = [];
    const row1 = [
      { text: "✅ Keep", callback_data: "keep" },
      { text: "❌ Skip", callback_data: "skip" },
    ];
    if (job.score >= (state.scoreThreshold || 3.5)) {
      row1.push({ text: "📋 Apply", callback_data: "apply" });
    }
    buttons.push(row1);

    const { tier } = detectATS(job.url);
    const msg = await bot.sendMessage(chatId, card, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons },
    });

    // Register in telegram-state.json so callbacks resolve
    const tgStatePath = TG_STATE_PATH;
    let tgState = { kept: [], skipped: [], pendingCards: {} };
    if (existsSync(tgStatePath)) {
      try { tgState = JSON.parse(readFileSync(tgStatePath, "utf-8")); } catch { /* ignore */ }
    }
    const jobId = (() => { try { return new URL(job.url).pathname.split("/").filter(Boolean).pop(); } catch { return null; } })();
    tgState.pendingCards[String(msg.message_id)] = {
      url: job.url, title: job.role, company: job.company,
      location: null, source: null, atsTier: tier, jobId,
    };
    writeFileSync(tgStatePath, JSON.stringify(tgState, null, 2), "utf-8");
  }

  log("🌅 Morning digest sent via Telegram");
}

// ── /usage — Claude Code subscription check ────────────────────────────────────

async function fetchClaudeUsage() {
  try {
    // claude /status prints rate-limit fields when a session is active
    const result = await runProcess("claude", ["/status"], { timeout: 20_000, shell: process.platform === "win32" });

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
  state.scoreThreshold = config.score_threshold;

  log(`🔍 Scan cycle #${state.today.scanCycles} starting`);

  // Pre-flight: disk usage check + live website context
  await checkDiskUsage(state);

  // Fetch portfolio + live CV PDF once per cycle (non-blocking — failures are logged)
  const websiteCtx = await fetchWebsiteContext();

  // Send a live-updating status message to Telegram
  const statusMsg = await sendTgMsg("🔍 <b>Scanning job portals...</b>");
  const statusMsgId = statusMsg?.message_id || null;

  // Snapshot pipeline URLs before scan to detect what's new afterwards
  const urlsBefore = readPipelineUrls();

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
    }
  }

  // ── Stage: eval ────────────────────────────────────────────────────────────
  if (config.enabled_stages.includes("eval")) {
    const newUrls = [...readPipelineUrls()].filter((u) => !urlsBefore.has(u));

    if (newUrls.length > 0) {
      await editTg(statusMsgId,
        `📊 Found <b>${newUrls.length}</b> new job(s). Evaluating with Gemini...`
      );

      const evalResults = await evalNewJobs(newUrls, websiteCtx, async (i, total, company) => {
        await editTg(statusMsgId,
          `📊 Evaluating <b>${i}/${total}</b>: ${escHtml(company)}...`
        );
      });

      state.today.evalResults = [...(state.today.evalResults || []), ...evalResults];
      const highScoring = evalResults.filter((r) => r.score >= config.score_threshold);
      state.today.highScoringJobs = [...(state.today.highScoringJobs || []), ...highScoring];

      log(`✅ Eval complete — ${evalResults.length} scored, ${highScoring.length} above ${config.score_threshold}`);

      // ── Stage: docs ─────────────────────────────────────────────────────────
      if (config.enabled_stages.includes("docs") && highScoring.length > 0) {
        await editTg(statusMsgId,
          `📄 Preparing docs for <b>${highScoring.length}</b> high-scoring job(s)...`
        );

        for (const job of highScoring) {
          log(`  📄 Preparing docs for ${job.company} — ${job.role} (${job.score}/5)`);
          const docs = await prepareDocsForJob(job, websiteCtx);
          if (docs) state.today.cvsGenerated += 1;
        }
      }

      const doneText = [
        `✅ Scan done — <b>${newUrls.length}</b> found, <b>${evalResults.length}</b> scored`,
        highScoring.length > 0
          ? `⭐ <b>${highScoring.length}</b> above ${config.score_threshold}/5 — docs prepared`
          : `None scored above ${config.score_threshold}/5`,
        config.morning_digest_time
          ? `🌅 Morning digest queued for ${config.morning_digest_time}`
          : "",
      ].filter(Boolean).join("\n");

      await editTg(statusMsgId, doneText);
    } else {
      await editTg(statusMsgId, "✅ Scan done — no new jobs found.");
    }
  } else if (statusMsgId) {
    // eval stage disabled — just update the status message
    const n = state.today.newOffers;
    await editTg(statusMsgId, n > 0
      ? `✅ Scan done — <b>${n}</b> new job(s) added to pipeline.`
      : "✅ Scan done — no new jobs found."
    );
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

    // Morning digest — ranked job cards from overnight eval
    if (isMorningDigestDue(state, config)) {
      state.scoreThreshold = config.score_threshold;
      await sendMorningDigest(state);
      state.today.morningDigestSent = true;
      saveState(state);
      ctx.state = state;
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
