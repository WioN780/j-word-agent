#!/usr/bin/env node
/**
 * relay-server.mjs — Express relay server bridging Telegram → browser → phone.
 *
 * Runs on a Raspberry Pi (or any always-on host). You access it from your
 * phone via Tailscale using the PI_HOSTNAME in .env.
 *
 * Routes:
 *   GET  /                       → Mobile-friendly list of pending applications
 *   GET  /apply/:job_id          → Job info + live screenshot + Approve/Reject buttons
 *   POST /apply/:job_id/approve  → Clicks submit in browser, sends Telegram confirmation
 *   POST /apply/:job_id/reject   → Closes browser tab, marks rejected
 *   GET  /screenshot/:job_id     → Returns live PNG screenshot for JS polling
 *   GET  /health                 → JSON health check
 *
 * Security: All routes require ?token=<RELAY_SECRET> or Authorization: Bearer <RELAY_SECRET>
 *
 * Setup:
 *   1. npm install express
 *   2. Add RELAY_SECRET and PI_HOSTNAME to .env
 *   3. node relay-server.mjs
 *
 * See docs/RELAY.md for full instructions.
 */

import express from "express";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { pathToFileURL } from "url";
import path from "path";
import dotenv from "dotenv";
import { BrowserSession } from "./session-manager.mjs";

dotenv.config();

const PORT = parseInt(process.env.RELAY_PORT || "3847", 10);
const RELAY_SECRET = process.env.RELAY_SECRET;
const PI_HOSTNAME = process.env.PI_HOSTNAME || "localhost";
const PENDING_PATH = "data/pending-applications.json";

// ── Active browser sessions (job_id → BrowserSession) ─────────────────────────

const activeSessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadPending() {
  if (!existsSync(PENDING_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PENDING_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function savePending(entries) {
  mkdirSync("data", { recursive: true });
  writeFileSync(PENDING_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

function findJob(jobId) {
  const entries = loadPending();
  return entries.find((e) => e.job_id === jobId) || null;
}

function updateJobStatus(jobId, status) {
  const entries = loadPending();
  const idx = entries.findIndex((e) => e.job_id === jobId);
  if (idx >= 0) {
    entries[idx].status = status;
    entries[idx].updated_at = new Date().toISOString();
    savePending(entries);
    return entries[idx];
  }
  return null;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tokenUrl(path) {
  return `${path}${path.includes("?") ? "&" : "?"}token=${RELAY_SECRET}`;
}

// ── Telegram notification helper ──────────────────────────────────────────────

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = new TelegramBot(token, { polling: false });
    await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  if (!RELAY_SECRET) {
    return res
      .status(500)
      .json({ error: "RELAY_SECRET not configured in .env" });
  }

  const queryToken = req.query.token;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (queryToken === RELAY_SECRET || bearerToken === RELAY_SECRET) {
    return next();
  }

  return res.status(401).json({
    error:
      "Unauthorized — provide ?token=SECRET or Authorization: Bearer SECRET",
  });
}

// ── HTML Templates ────────────────────────────────────────────────────────────

const CSS = `
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #0f0f0f;
    color: #e0e0e0;
    padding: 16px;
    max-width: 600px;
    margin: 0 auto;
    -webkit-text-size-adjust: 100%;
  }
  h1, h2 { color: #fff; margin-bottom: 12px; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.2rem; }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid #333;
    margin-bottom: 16px;
  }
  .badge {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-waiting { background: #f59e0b; color: #000; }
  .badge-approved { background: #22c55e; color: #000; }
  .badge-rejected { background: #ef4444; color: #fff; }
  .card {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 12px;
    text-decoration: none;
    display: block;
    color: inherit;
    transition: border-color 0.2s;
  }
  .card:active, .card:hover { border-color: #3b82f6; }
  .card-title { font-weight: 600; font-size: 1rem; color: #fff; margin-bottom: 4px; }
  .card-meta { font-size: 0.85rem; color: #999; }
  .card-meta span { margin-right: 12px; }
  .screenshot-container {
    background: #111;
    border: 1px solid #333;
    border-radius: 8px;
    overflow: hidden;
    margin: 16px 0;
  }
  .screenshot-container img {
    width: 100%;
    height: auto;
    display: block;
  }
  .btn-row {
    display: flex;
    gap: 12px;
    margin-top: 16px;
  }
  .btn {
    flex: 1;
    padding: 16px;
    border: none;
    border-radius: 12px;
    font-size: 1.1rem;
    font-weight: 700;
    cursor: pointer;
    text-align: center;
    transition: opacity 0.2s;
    text-decoration: none;
    display: inline-block;
  }
  .btn:active { opacity: 0.7; }
  .btn-approve { background: #22c55e; color: #000; }
  .btn-reject { background: #ef4444; color: #fff; }
  .btn-back { background: #333; color: #fff; }
  .info-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #222;
    font-size: 0.9rem;
  }
  .info-label { color: #999; }
  .info-value { color: #fff; font-weight: 500; text-align: right; max-width: 60%; word-break: break-all; }
  .empty {
    text-align: center;
    padding: 48px 16px;
    color: #666;
    font-size: 1.1rem;
  }
  .status-msg {
    text-align: center;
    padding: 32px 16px;
    border-radius: 12px;
    margin: 16px 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .status-msg.success { background: #052e16; color: #22c55e; border: 1px solid #22c55e; }
  .status-msg.error { background: #2d0f0f; color: #ef4444; border: 1px solid #ef4444; }
  .loading { text-align: center; padding: 24px; color: #666; }
  a { color: #3b82f6; }
</style>
`;

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)} — career-ops relay</title>
  ${CSS}
</head>
<body>
${body}
</body>
</html>`;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Unauthenticated liveness probe — used by Docker / monitoring.
// Must be registered BEFORE authMiddleware so no token is required.
app.get("/ping", (_req, res) => res.json({ ok: true }));

// Apply auth to all other routes
app.use(authMiddleware);

// ── GET / — List all pending applications ─────────────────────────────────────

app.get("/", (req, res) => {
  const entries = loadPending();
  const pending = entries.filter((e) => e.status === "awaiting_review");
  const others = entries.filter((e) => e.status !== "awaiting_review");

  let cards = "";
  if (pending.length === 0) {
    cards = '<div class="empty">📭 No pending applications</div>';
  } else {
    for (const job of pending) {
      const title = job.title || "Unknown Position";
      const company = job.ats_type || job.company || "Unknown";
      const date = job.filled_at
        ? new Date(job.filled_at).toLocaleDateString()
        : "—";
      cards += `
        <a class="card" href="${tokenUrl(`/apply/${encodeURIComponent(job.job_id)}`)}">
          <div class="card-title">${escapeHtml(title)}</div>
          <div class="card-meta">
            <span>🏢 ${escapeHtml(company)}</span>
            <span>📅 ${escapeHtml(date)}</span>
            <span class="badge badge-waiting">Review</span>
          </div>
        </a>`;
    }
  }

  // Show recently processed
  let recentHtml = "";
  const recent = others.slice(-5).reverse();
  if (recent.length > 0) {
    recentHtml = '<h2 style="margin-top: 24px;">Recent</h2>';
    for (const job of recent) {
      const badgeClass =
        job.status === "submitted" ? "badge-approved" : "badge-rejected";
      recentHtml += `
        <div class="card" style="opacity: 0.6;">
          <div class="card-title">${escapeHtml(job.title || "Unknown")}</div>
          <div class="card-meta">
            <span>🏢 ${escapeHtml(job.ats_type || job.company || "")}</span>
            <span class="badge ${badgeClass}">${escapeHtml(job.status)}</span>
          </div>
        </div>`;
    }
  }

  const body = `
    <div class="header">
      <h1>📋 career-ops relay</h1>
      <span style="font-size: 0.8rem; color: #666;">${pending.length} pending</span>
    </div>
    ${cards}
    ${recentHtml}
  `;

  res.send(htmlPage("Dashboard", body));
});

// ── GET /apply/:job_id — Show job info + screenshot + buttons ─────────────────

app.get("/apply/:job_id", (req, res) => {
  const job = findJob(req.params.job_id);
  if (!job) {
    return res.status(404).send(
      htmlPage(
        "Not Found",
        `
      <div class="status-msg error">❌ Job not found: ${escapeHtml(req.params.job_id)}</div>
      <a class="btn btn-back" href="${tokenUrl("/")}" style="display:block;text-align:center;margin-top:16px;">← Back</a>
    `,
      ),
    );
  }

  const statusBadge =
    job.status === "awaiting_review"
      ? '<span class="badge badge-waiting">Awaiting Review</span>'
      : job.status === "submitted"
        ? '<span class="badge badge-approved">Submitted</span>'
        : `<span class="badge badge-rejected">${escapeHtml(job.status)}</span>`;

  const screenshotUrl = tokenUrl(
    `/screenshot/${encodeURIComponent(job.job_id)}`,
  );
  const approveUrl = tokenUrl(
    `/apply/${encodeURIComponent(job.job_id)}/approve`,
  );
  const rejectUrl = tokenUrl(`/apply/${encodeURIComponent(job.job_id)}/reject`);

  const buttons =
    job.status === "awaiting_review"
      ? `<div class="btn-row">
        <form method="POST" action="${approveUrl}" style="flex:1;display:flex;">
          <button type="submit" class="btn btn-approve" style="flex:1;"
                  onclick="this.disabled=true; this.textContent='Submitting…'; this.form.submit();">
            ✅ Approve & Submit
          </button>
        </form>
        <form method="POST" action="${rejectUrl}" style="flex:1;display:flex;">
          <button type="submit" class="btn btn-reject" style="flex:1;"
                  onclick="this.disabled=true; this.textContent='Rejecting…'; this.form.submit();">
            ❌ Reject
          </button>
        </form>
      </div>`
      : "";

  const body = `
    <a class="btn btn-back" href="${tokenUrl("/")}" style="display:inline-block;margin-bottom:16px;padding:8px 16px;font-size:0.9rem;">← Back</a>

    <h1>${escapeHtml(job.title || "Unknown Position")}</h1>
    ${statusBadge}

    <div style="margin-top: 16px;">
      <div class="info-row">
        <span class="info-label">ATS</span>
        <span class="info-value">${escapeHtml(job.ats_type || "—")}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Company</span>
        <span class="info-value">${escapeHtml(job.company || "—")}</span>
      </div>
      <div class="info-row">
        <span class="info-label">URL</span>
        <span class="info-value"><a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">Open ↗</a></span>
      </div>
      <div class="info-row">
        <span class="info-label">Filled at</span>
        <span class="info-value">${escapeHtml(job.filled_at || "—")}</span>
      </div>
    </div>

    <div class="screenshot-container">
      <img id="screenshot" src="${screenshotUrl}" alt="Form screenshot"
           onerror="this.alt='Screenshot unavailable'; this.style.padding='24px'; this.style.textAlign='center';">
    </div>

    ${buttons}

    ${
      job.status === "awaiting_review"
        ? `
    <script>
      // Auto-refresh screenshot every 3 seconds
      (function() {
        const img = document.getElementById('screenshot');
        const baseUrl = '${screenshotUrl}';
        setInterval(function() {
          const newImg = new Image();
          newImg.onload = function() { img.src = newImg.src; };
          newImg.src = baseUrl + '&_t=' + Date.now();
        }, 3000);
      })();
    </script>`
        : ""
    }
  `;

  res.send(htmlPage(job.title || "Review Application", body));
});

// ── POST /apply/:job_id/approve — Click submit, send confirmation ─────────────

app.post("/apply/:job_id/approve", async (req, res) => {
  const jobId = req.params.job_id;
  const job = findJob(jobId);

  if (!job) {
    return res.status(404).send(
      htmlPage(
        "Not Found",
        `
      <div class="status-msg error">❌ Job not found</div>
      <a class="btn btn-back" href="${tokenUrl("/")}" style="display:block;text-align:center;margin-top:16px;">← Back</a>
    `,
      ),
    );
  }

  if (job.status !== "awaiting_review") {
    return res.send(
      htmlPage(
        "Already Processed",
        `
      <div class="status-msg error">⚠️ This application has already been processed (${escapeHtml(job.status)})</div>
      <a class="btn btn-back" href="${tokenUrl("/")}" style="display:block;text-align:center;margin-top:16px;">← Back</a>
    `,
      ),
    );
  }

  try {
    // Attempt to click submit in the active browser session
    const session = activeSessions.get(jobId);
    if (session?.page) {
      // Find and click the submit button
      const clicked = await session.page.evaluate(() => {
        const candidates = [
          ...document.querySelectorAll(
            'input[type="submit"], button[type="submit"]',
          ),
          ...[...document.querySelectorAll("button")].filter((b) =>
            /submit|apply/i.test(b.textContent),
          ),
        ];
        if (candidates.length > 0) {
          // Remove the safety styling first
          for (const btn of candidates) {
            btn.style.outline = "";
            btn.style.opacity = "1";
          }
          candidates[0].click();
          return true;
        }
        return false;
      });

      if (clicked) {
        // Wait briefly for submission to process
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Update status
    updateJobStatus(jobId, "submitted");

    // Send Telegram confirmation
    const msg = [
      "✅ <b>Application Submitted</b>",
      "",
      `🏢 <b>${escapeHtml(job.company)}</b> — ${escapeHtml(job.title)}`,
      `🔗 ${escapeHtml(job.url)}`,
      "",
      `Approved via relay at ${new Date().toLocaleTimeString()}`,
    ].join("\n");
    await sendTelegramMessage(msg);

    // Clean up session
    if (session) {
      await session.close().catch(() => {});
      activeSessions.delete(jobId);
    }

    res.send(
      htmlPage(
        "Approved",
        `
      <div class="status-msg success">✅ Application submitted successfully!</div>
      <div style="text-align:center;margin:16px 0;">
        <p>${escapeHtml(job.title)}</p>
        <p style="color:#999;font-size:0.9rem;">${escapeHtml(job.company)}</p>
      </div>
      <a class="btn btn-back" href="${tokenUrl("/")}" style="display:block;text-align:center;">← Back to Dashboard</a>
    `,
      ),
    );
  } catch (err) {
    console.error("Approve error:", err);
    res.status(500).send(
      htmlPage(
        "Error",
        `
      <div class="status-msg error">❌ Error: ${escapeHtml(err.message)}</div>
      <a class="btn btn-back" href="${tokenUrl("/")}" style="display:block;text-align:center;margin-top:16px;">← Back</a>
    `,
      ),
    );
  }
});

// ── POST /apply/:job_id/reject — Close browser tab, mark rejected ─────────────

app.post("/apply/:job_id/reject", async (req, res) => {
  const jobId = req.params.job_id;
  const job = findJob(jobId);

  if (!job) {
    return res.status(404).send(
      htmlPage(
        "Not Found",
        `
      <div class="status-msg error">❌ Job not found</div>
      <a class="btn btn-back" href="${tokenUrl("/")}" style="display:block;text-align:center;margin-top:16px;">← Back</a>
    `,
      ),
    );
  }

  try {
    // Close browser session if active
    const session = activeSessions.get(jobId);
    if (session) {
      await session.close().catch(() => {});
      activeSessions.delete(jobId);
    }

    // Update status
    updateJobStatus(jobId, "rejected");

    // Send Telegram notification
    const msg = [
      "❌ <b>Application Rejected</b>",
      "",
      `🏢 <b>${escapeHtml(job.company)}</b> — ${escapeHtml(job.title)}`,
      "",
      `Rejected via relay at ${new Date().toLocaleTimeString()}`,
    ].join("\n");
    await sendTelegramMessage(msg);

    res.send(
      htmlPage(
        "Rejected",
        `
      <div class="status-msg error">❌ Application rejected</div>
      <div style="text-align:center;margin:16px 0;">
        <p>${escapeHtml(job.title)}</p>
        <p style="color:#999;font-size:0.9rem;">${escapeHtml(job.company)}</p>
      </div>
      <a class="btn btn-back" href="${tokenUrl("/")}" style="display:block;text-align:center;">← Back to Dashboard</a>
    `,
      ),
    );
  } catch (err) {
    console.error("Reject error:", err);
    res.status(500).send(
      htmlPage(
        "Error",
        `
      <div class="status-msg error">❌ Error: ${escapeHtml(err.message)}</div>
      <a class="btn btn-back" href="${tokenUrl("/")}" style="display:block;text-align:center;margin-top:16px;">← Back</a>
    `,
      ),
    );
  }
});

// ── GET /screenshot/:job_id — Return live screenshot PNG ──────────────────────

app.get("/screenshot/:job_id", async (req, res) => {
  const jobId = req.params.job_id;
  const job = findJob(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  // Try to get a live screenshot from the active browser session
  const session = activeSessions.get(jobId);
  if (session?.page) {
    try {
      const buf = await session.page.screenshot({
        type: "png",
        fullPage: true,
      });
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.send(buf);
    } catch (err) {
      console.error(`Live screenshot error for ${jobId}:`, err.message);
      // Fall through to stored screenshot
    }
  }

  // Fall back to stored base64 screenshot
  if (job.screenshot) {
    const buf = Buffer.from(job.screenshot, "base64");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(buf);
  }

  res.status(404).json({ error: "No screenshot available" });
});

// ── Health endpoint helpers ───────────────────────────────────────────────────

/** Read scheduler state from data/scheduler-state.json (best-effort, returns null on error). */
function loadSchedulerState() {
  const p = "data/scheduler-state.json";
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/** Recursively sum file sizes under `dir`, return total in whole MB (0 if missing). */
function getDirSizeMb(dir) {
  let bytes = 0;
  try {
    if (!existsSync(dir)) return 0;
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) bytes += statSync(full).size;
      }
    };
    walk(dir);
  } catch {
    /* ignore */
  }
  return Math.round(bytes / 1024 / 1024);
}

// ── GET /health — JSON health check ───────────────────────────────────────────

app.get("/health", (req, res) => {
  const entries = loadPending();
  const pending = entries.filter((e) => e.status === "awaiting_review");
  const schedState = loadSchedulerState();
  const diskMb = getDirSizeMb("output");
  const uptimeHours = Math.round((process.uptime() / 3600) * 10) / 10;

  res.json({
    status: "ok",
    uptime_hours: uptimeHours,
    last_scan: schedState?.lastScanTime ?? null,
    pending_applications: pending.length,
    total_applications: entries.length,
    today_stats: schedState?.today
      ? {
          scanned: schedState.today.scanCycles ?? 0,
          passed: schedState.today.newOffers ?? 0,
          cvs_generated: schedState.today.cvsGenerated ?? 0,
        }
      : null,
    disk_usage_mb: diskMb,
    active_sessions: activeSessions.size,
    scheduler_paused: schedState?.paused ?? null,
    circuit_open: schedState?.circuitOpen ?? null,
    version: "1.0.0",
  });
});

// ── Public API for telegram-bot.mjs integration ───────────────────────────────

/**
 * Generate a relay review URL for a given job_id.
 * Used by telegram-bot.mjs to include a clickable link in the Telegram card.
 *
 * @param {string} jobId
 * @returns {string|null} Full URL with auth token, or null if not configured
 */
export function getRelayUrl(jobId) {
  if (!RELAY_SECRET || !PI_HOSTNAME) return null;
  const port = PORT !== 80 ? `:${PORT}` : "";
  return `http://${PI_HOSTNAME}${port}/apply/${encodeURIComponent(jobId)}?token=${RELAY_SECRET}`;
}

/**
 * Register an active browser session so the relay can take live screenshots
 * and click submit on behalf of the user.
 *
 * @param {string} jobId
 * @param {BrowserSession} session
 */
export function registerSession(jobId, session) {
  activeSessions.set(jobId, session);
}

/**
 * Unregister a browser session (e.g., after the user closes it locally).
 *
 * @param {string} jobId
 */
export function unregisterSession(jobId) {
  activeSessions.delete(jobId);
}

// ── Start server (standalone mode) ────────────────────────────────────────────

async function main() {
  if (!RELAY_SECRET) {
    console.error(
      "Error: RELAY_SECRET is not set — add it to .env (see docs/RELAY.md)",
    );
    process.exit(1);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🔗 career-ops relay server running`);
    console.log(`   Local:     http://localhost:${PORT}/`);
    console.log(`   Tailscale: http://${PI_HOSTNAME}:${PORT}/`);
    console.log(`   Health:    http://localhost:${PORT}/health?token=***`);
    console.log(`\n   Token auth: enabled`);
    console.log(
      `   Pending:    ${loadPending().filter((e) => e.status === "awaiting_review").length} applications\n`,
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}

export { app };
