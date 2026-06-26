#!/usr/bin/env node
/**
 * session-manager.mjs — Persistent Playwright browser session for Tier 1 ATS auto-fill.
 *
 * SAFETY: This tool fills forms but NEVER clicks Submit. The user must review and
 * submit manually. All auto-filled entries are written to data/pending-applications.json
 * with status "awaiting_review" until the user confirms.
 *
 * Usage:
 *   node session-manager.mjs <url>               # auto-detect ATS and fill form
 *   node session-manager.mjs <url> --dump-form   # dump all form fields for inspection
 *   node session-manager.mjs <url> --no-pause    # fill, screenshot, close (no stdin wait)
 *
 * Profile data: config/profile.yml (candidate.full_name, email, phone, linkedin, etc.)
 * CV files:     output/ directory (most recent .pdf used unless a company slug matches)
 * Browser profile: data/browser-profile/ (gitignored — persists cookies/sessions across runs)
 * Pending log:  data/pending-applications.json
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';
import yaml from 'js-yaml';
import { detectATS } from './ats-detector.mjs';

const PROFILE_DIR = 'data/browser-profile';
const PENDING_PATH = 'data/pending-applications.json';

// ── Profile loader ────────────────────────────────────────────────────────────

function loadProfile() {
  const profilePath = 'config/profile.yml';
  if (!existsSync(profilePath)) return {};
  try {
    const raw = yaml.load(readFileSync(profilePath, 'utf-8'));
    const c = raw?.candidate || {};
    return {
      name: c.full_name || '',
      email: c.email || '',
      phone: c.phone || '',
      linkedIn: c.linkedin || '',
      github: c.github || '',
      website: c.portfolio_url || '',
      twitter: c.twitter || '',
    };
  } catch {
    return {};
  }
}

// ── CV finder ─────────────────────────────────────────────────────────────────

function findLatestCv(slug = null) {
  if (!existsSync('output')) return null;
  const files = readdirSync('output').filter(f => f.endsWith('.pdf'));
  if (files.length === 0) return null;

  if (slug) {
    const specific = files.filter(f => f.toLowerCase().includes(slug.toLowerCase())).sort().reverse();
    if (specific.length > 0) return path.resolve('output', specific[0]);
  }
  const sorted = files
    .map(f => ({ name: f, mtime: statSync(path.join('output', f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return sorted.length > 0 ? path.resolve('output', sorted[0].name) : null;
}

// ── Pending applications log ──────────────────────────────────────────────────

function writePending(entry) {
  mkdirSync('data', { recursive: true });
  let existing = [];
  if (existsSync(PENDING_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(PENDING_PATH, 'utf-8'));
      existing = Array.isArray(parsed) ? parsed : [parsed];
    } catch { existing = []; }
  }
  const idx = existing.findIndex(e => e.url === entry.url);
  if (idx >= 0) existing[idx] = entry;
  else existing.push(entry);
  writeFileSync(PENDING_PATH, JSON.stringify(existing, null, 2), 'utf-8');
}

// ── BrowserSession ────────────────────────────────────────────────────────────

export class BrowserSession {
  constructor() {
    this.context = null;
    this.page = null;
  }

  async launch() {
    mkdirSync(PROFILE_DIR, { recursive: true });
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  /**
   * Dump all form fields visible on the current page.
   * Used by --dump-form to discover real selectors before writing fillers.
   */
  async dumpFormFields() {
    return this.page.evaluate(() => {
      const fields = [];
      for (const el of document.querySelectorAll('input, select, textarea, button[type="submit"], button')) {
        if (el.tagName === 'BUTTON' && el.type !== 'submit' && !/submit|apply/i.test(el.textContent)) continue;
        const labelEl = el.id
          ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
          : el.closest('label');
        const label = (labelEl?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 100);
        fields.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          label,
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
        });
      }
      return fields;
    });
  }

  // ── Greenhouse ──────────────────────────────────────────────────────────────

  async fillGreenhouse(jobData) {
    const p = this.page;
    await p.waitForSelector('input, textarea', { timeout: 15_000 });
    // Greenhouse's modern layout has a hero Apply button that scrolls to the form below the JD.
    // Scroll to the form's first field so it is in the viewport and interactable.
    await p.locator('#first_name').scrollIntoViewIfNeeded().catch(() => null);

    const tryFill = async (selectors, value) => {
      if (!value) return false;
      for (const sel of selectors) {
        try {
          const el = await p.$(sel);
          if (el && await el.isVisible()) {
            await el.fill(String(value));
            return true;
          }
        } catch { /* selector invalid on this page */ }
      }
      return false;
    };

    // Split full name into first / last (Greenhouse uses two fields)
    if (jobData.name) {
      const parts = jobData.name.trim().split(/\s+/);
      const first = parts[0] || '';
      const last = parts.slice(1).join(' ') || parts[0] || '';
      await tryFill(['#first_name', 'input[name="first_name"]', 'input[id="first_name"]'], first);
      await tryFill(['#last_name', 'input[name="last_name"]', 'input[id="last_name"]'], last);
    }

    await tryFill(['#email', 'input[name="email"]', 'input[type="email"]'], jobData.email);
    await tryFill(['#phone', 'input[name="phone"]', 'input[type="tel"]'], jobData.phone);

    // Resume upload.
    // Greenhouse's modern forms use Filepicker (a JS upload widget backed by S3/CDN).
    // setInputFiles() targets the native hidden input — this works when Greenhouse reads
    // from input.files on submission, but is silently ignored when Filepicker uploads
    // the file separately and stores a CDN token in its own hidden field.
    // Either way, the console warns the user to verify before submitting.
    if (jobData.cvPath && existsSync(jobData.cvPath)) {
      let uploadAttempted = false;
      for (const sel of ['#resume', 'input[name="resume"]']) {
        const el = await p.$(sel);
        if (el) { await el.setInputFiles(jobData.cvPath); uploadAttempted = true; break; }
      }
      if (uploadAttempted) {
        console.log(`  ⚠️  Resume: attempted upload — if Greenhouse shows "Attach" still, click it and select ${jobData.cvPath} manually.`);
      }
    } else {
      console.log('  ⚠️  Resume: no CV found in output/ — attach manually in the browser.');
    }

    // Cover letter (optional — many Greenhouse forms don't have it)
    if (jobData.coverLetterPath && existsSync(jobData.coverLetterPath)) {
      const el = await p.$('#cover_letter, input[name="cover_letter"]');
      if (el) await el.setInputFiles(jobData.coverLetterPath);
    }

    // LinkedIn — Greenhouse puts this in a custom question (label text varies by company)
    if (jobData.linkedIn) {
      let filled = false;
      try {
        const linked = p.getByLabel(/linkedin/i).first();
        if (await linked.isVisible({ timeout: 2_000 })) {
          await linked.fill(jobData.linkedIn);
          filled = true;
        }
      } catch { /* not found */ }
      if (!filled) {
        await tryFill([
          'input[id*="linkedin" i]', 'input[name*="linkedin" i]', 'input[placeholder*="linkedin" i]',
        ], jobData.linkedIn);
      }
    }

    // GitHub
    if (jobData.github) {
      try {
        const gh = p.getByLabel(/github/i).first();
        if (await gh.isVisible({ timeout: 2_000 })) await gh.fill(jobData.github);
      } catch { /* absent */ }
    }

    // Website / portfolio
    if (jobData.website) {
      try {
        const site = p.getByLabel(/website|portfolio/i).first();
        if (await site.isVisible({ timeout: 2_000 })) await site.fill(jobData.website);
      } catch { /* absent */ }
    }

    await this._highlightSubmit();
  }

  // ── Lever ───────────────────────────────────────────────────────────────────

  async fillLever(jobData) {
    const p = this.page;
    await p.waitForSelector('input, textarea', { timeout: 15_000 });

    const tryFill = async (selectors, value) => {
      if (!value) return false;
      for (const sel of selectors) {
        try {
          const el = await p.$(sel);
          if (el && await el.isVisible()) {
            await el.fill(String(value));
            return true;
          }
        } catch { /* selector invalid */ }
      }
      return false;
    };

    // Lever uses a single name field
    await tryFill(['input[name="name"]', 'input[name="full_name"]'], jobData.name);
    await tryFill(['input[name="email"]', 'input[type="email"]'], jobData.email);
    await tryFill(['input[name="phone"]'], jobData.phone);
    // org = current company; intentionally left blank when unknown
    await tryFill(['input[name="org"]'], '');

    // URL fields — Lever uses urls[LinkedIn], urls[GitHub], etc.
    await tryFill(['input[name="urls[LinkedIn]"]', 'input[name="linkedin"]'], jobData.linkedIn);
    await tryFill(['input[name="urls[GitHub]"]', 'input[name="github"]'], jobData.github);
    await tryFill(
      ['input[name="urls[Portfolio]"]', 'input[name="urls[Website]"]', 'input[name="urls[Other]"]'],
      jobData.website,
    );
    await tryFill(['input[name="urls[Twitter]"]'], jobData.twitter);

    // Resume upload
    if (jobData.cvPath && existsSync(jobData.cvPath)) {
      const el = await p.$('input[type="file"]');
      if (el) await el.setInputFiles(jobData.cvPath);
    }

    await this._highlightSubmit();
  }

  // ── Ashby ───────────────────────────────────────────────────────────────────

  async fillAshby(jobData) {
    const p = this.page;
    // Ashby forms are React-rendered — wait longer for hydration
    await p.waitForSelector('input, textarea', { timeout: 20_000 });

    const tryLabel = async (pattern, value) => {
      if (!value) return false;
      try {
        const el = p.getByLabel(pattern, { exact: false }).first();
        if (await el.isVisible({ timeout: 2_000 })) {
          await el.fill(String(value));
          return true;
        }
      } catch { /* label absent */ }
      return false;
    };

    // Ashby uses a single name field
    await tryLabel(/^name$/i, jobData.name) || await tryLabel(/full.?name/i, jobData.name);
    await tryLabel(/email/i, jobData.email);
    await tryLabel(/phone/i, jobData.phone);
    await tryLabel(/linkedin/i, jobData.linkedIn);
    await tryLabel(/github/i, jobData.github);
    await tryLabel(/website|portfolio/i, jobData.website);

    // Resume
    if (jobData.cvPath && existsSync(jobData.cvPath)) {
      const el = await p.$('input[type="file"]');
      if (el) await el.setInputFiles(jobData.cvPath);
    }

    // Cover letter (optional second file input)
    if (jobData.coverLetterPath && existsSync(jobData.coverLetterPath)) {
      const inputs = await p.$$('input[type="file"]');
      if (inputs.length >= 2) await inputs[1].setInputFiles(jobData.coverLetterPath);
    }

    await this._highlightSubmit();
  }

  // ── Submit guard ─────────────────────────────────────────────────────────────

  /** Locate the submit button visually (red outline + dimmed) — NEVER clicks it. */
  async _highlightSubmit() {
    await this.page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll('input[type="submit"], button[type="submit"]'),
        ...[...document.querySelectorAll('button')].filter(b => /submit|apply/i.test(b.textContent)),
      ];
      for (const btn of candidates) {
        btn.style.outline = '4px solid red';
        btn.style.opacity = '0.5';
        btn.title = '[career-ops] Do not click — review first, then submit manually';
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  /**
   * Keep the browser open for user review. Resolves when Enter is pressed.
   * Set --no-pause flag or CAREER_OPS_NO_PAUSE=1 env var to skip the wait.
   */
  async pause(noPause = false) {
    if (noPause || process.env.CAREER_OPS_NO_PAUSE === '1') return;
    return new Promise(resolve => {
      process.stdout.write('\n[career-ops] Form filled. Review the browser, then press Enter to close it.\n');
      process.stdin.resume();
      const onData = () => {
        process.stdin.pause();
        resolve();
      };
      process.stdin.once('data', onData);
    });
  }

  /** Returns a base64-encoded PNG screenshot (full page — captures submit button state). */
  async screenshot() {
    const buf = await this.page.screenshot({ type: 'png', fullPage: true });
    return buf.toString('base64');
  }

  async close() {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}

// ── Main (standalone) ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => a.startsWith('http'));
  const dumpForm = args.includes('--dump-form');
  const noPause = args.includes('--no-pause');

  if (!url) {
    console.error('Usage: node session-manager.mjs <url> [--dump-form] [--no-pause]');
    process.exit(1);
  }

  const { type, tier } = detectATS(url);
  console.log(`URL:    ${url}`);
  console.log(`ATS:    ${type} (tier ${tier})`);

  if (tier !== 1 && !dumpForm) {
    console.warn(`⚠️  ${type} is a Tier ${tier} ATS — only Tier 1 (Greenhouse/Ashby/Lever) supports auto-fill.`);
    process.exit(1);
  }

  const profile = loadProfile();
  const cvPath = findLatestCv();
  console.log(`Profile: ${profile.name || '(no profile found)'} <${profile.email || ''}>`);
  console.log(`CV:      ${cvPath || '(none found in output/)'}`);

  const jobData = { ...profile, cvPath, coverLetterPath: null };

  const session = new BrowserSession();
  try {
    console.log('\nLaunching browser…');
    await session.launch();
    await session.navigate(url);
    console.log(`Navigated to: ${session.page.url()}`);

    if (dumpForm) {
      const fields = await session.dumpFormFields();
      console.log('\n--- Form fields on page ---');
      for (const f of fields) {
        const parts = [
          `<${f.tag}>`,
          f.type && `type=${f.type}`,
          f.name && `name="${f.name}"`,
          f.id && `id="${f.id}"`,
          f.label && `label="${f.label}"`,
          f.placeholder && `placeholder="${f.placeholder}"`,
        ].filter(Boolean);
        console.log('  ' + parts.join(' '));
      }
      await session.pause(noPause);
      await session.close();
      return;
    }

    console.log(`\nFilling ${type} form…`);
    if (type === 'greenhouse') await session.fillGreenhouse(jobData);
    else if (type === 'ashby') await session.fillAshby(jobData);
    else if (type === 'lever') await session.fillLever(jobData);

    console.log('Taking screenshot…');
    const screenshotB64 = await session.screenshot();

    const jobId = new URL(url).pathname.split('/').filter(Boolean).pop() || 'unknown';
    const entry = {
      job_id: jobId,
      company: type,
      title: await session.page.title(),
      url,
      ats_type: type,
      status: 'awaiting_review',
      filled_at: new Date().toISOString(),
      screenshot: screenshotB64,
    };
    writePending(entry);
    console.log(`\nSaved → ${PENDING_PATH}`);
    console.log('Status: awaiting_review — submit manually after review. The submit button is highlighted red.');

    await session.pause(noPause);
  } finally {
    await session.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
