#!/usr/bin/env node
/**
 * apply-card.mjs — Generate "Apply Data Cards" for Tier 2/3 jobs.
 *
 * When a job can't be auto-filled (Workday, Taleo, iCIMS, unknown portals),
 * this module generates a formatted data card with all personal info and
 * pre-answered questions so you can fill the form manually as fast as possible.
 *
 * Exports:
 *   generateApplyCard(job, profile)      — returns { markdown, telegram }
 *   generateAndSaveApplyCard(job)        — loads profile, generates, saves to disk
 *   loadProfile()                        — loads config/profile.yml
 *
 * The card includes:
 *   - Personal info (name, email, phone, LinkedIn, GitHub, website)
 *   - Pre-answered common application questions
 *   - Workday-specific field guidance (for Tier 2 jobs)
 *   - CV path and direct apply URL
 *
 * Usage:
 *   node apply-card.mjs <url> [--ats workday|unknown] [--company "Name"] [--title "Title"]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { detectATS } from './ats-detector.mjs';

const PROFILE_PATH = 'config/profile.yml';
const CARDS_DIR = 'data/apply-cards';
const OUTPUT_DIR = 'output';

// ── Profile Loader ────────────────────────────────────────────────────────────

/**
 * Load the user's profile from config/profile.yml.
 * @returns {object} Parsed profile YAML
 */
export function loadProfile() {
  if (!existsSync(PROFILE_PATH)) {
    throw new Error(`Profile not found at ${PROFILE_PATH}. Run onboarding first.`);
  }
  return yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
}

// ── Workday Field Mapping ─────────────────────────────────────────────────────
// Workday uses consistent field labels across all companies. This mapping
// helps users quickly identify which profile data goes into which field.

const WORKDAY_FIELDS = {
  personal: [
    { field: 'Legal Name → First Name', profileKey: 'first_name', section: 'My Information' },
    { field: 'Legal Name → Last Name', profileKey: 'last_name', section: 'My Information' },
    { field: 'Address → Address Line 1', profileKey: null, note: 'Your street address' },
    { field: 'Address → City', profileKey: 'city', section: 'My Information' },
    { field: 'Address → State/Province', profileKey: null, note: 'Your state/province' },
    { field: 'Address → Postal Code', profileKey: null, note: 'Your postal/ZIP code' },
    { field: 'Phone → Phone Number', profileKey: 'phone', section: 'My Information' },
    { field: 'Phone → Phone Device Type', profileKey: null, note: 'Usually "Mobile"' },
    { field: 'Email Address', profileKey: 'email', section: 'My Information' },
  ],
  experience: [
    { field: 'Job Title', note: 'Most recent role title' },
    { field: 'Company', note: 'Most recent employer' },
    { field: 'From / To', note: 'Date range (MM/YYYY)' },
    { field: 'Description', note: 'Copy from CV — keep under 2000 chars' },
  ],
  selfId: [
    { field: 'How Did You Hear About Us?', note: 'Select "Job Board" or "Company Website"' },
    { field: 'Gender', note: 'Optional — "Decline to Self Identify" is always available' },
    { field: 'Ethnicity', note: 'Optional — "Decline to Self Identify" is always available' },
    { field: 'Veteran Status', note: 'Optional — "I am not a protected veteran"' },
    { field: 'Disability Status', note: 'Optional — "I don\'t wish to answer"' },
  ],
  tips: [
    '💡 Workday auto-saves drafts — you can close and resume later',
    '💡 "Apply with LinkedIn" pre-fills most personal fields (recommended)',
    '💡 Upload your CV first — Workday often parses it to pre-fill experience',
    '💡 The "Review" step at the end lets you edit before submitting',
    '💡 Workday forms are multi-page: My Information → My Experience → Application Questions → Voluntary Disclosures → Review',
    '💡 If asked for salary in a number field, enter the LOWER bound of your range',
    '💡 "Additional Information" text boxes accept plain text only — no formatting',
  ],
};

// ── Card Generator ────────────────────────────────────────────────────────────

/**
 * Find the most recent tailored CV PDF for a given company, or fall back to
 * the most recent CV PDF in the output directory.
 * @param {string} company - Company name to search for
 * @returns {string|null} Path to the CV PDF, or null
 */
function findCvPdf(company) {
  if (!existsSync(OUTPUT_DIR)) return null;

  const files = readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith('.pdf') && f.toLowerCase().includes('cv'))
    .sort()
    .reverse();

  // Try company-specific first
  const slug = company?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || '';
  const companyMatch = files.find(f => f.toLowerCase().includes(slug));
  if (companyMatch) return path.join(OUTPUT_DIR, companyMatch);

  // Fall back to most recent
  if (files.length > 0) return path.join(OUTPUT_DIR, files[0]);

  return null;
}

/**
 * Extract a job ID from a URL for use as a filename.
 * @param {string} url
 * @returns {string}
 */
function extractJobId(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    // For Workday, the job ID is typically the last path segment
    return segments[segments.length - 1] || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Split a full name into first and last name.
 * @param {string} fullName
 * @returns {{ firstName: string, lastName: string }}
 */
function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

/**
 * Calculate years of experience from CV content.
 * Falls back to a reasonable estimate based on profile.
 * @param {object} profile
 * @returns {string}
 */
function estimateYearsExperience(profile) {
  // Try to read cv.md and estimate from dates
  try {
    if (existsSync('cv.md')) {
      const cv = readFileSync('cv.md', 'utf-8');
      const yearMatches = cv.match(/\b(19|20)\d{2}\b/g);
      if (yearMatches && yearMatches.length >= 2) {
        const years = yearMatches.map(Number);
        const range = Math.max(...years) - Math.min(...years);
        if (range > 0 && range < 50) return `${range}+ years`;
      }
    }
  } catch { /* ignore */ }

  // Fall back to archetype level
  const level = profile?.target_roles?.archetypes?.[0]?.level || '';
  if (level.toLowerCase().includes('senior')) return '5+ years';
  if (level.toLowerCase().includes('mid')) return '3+ years';
  if (level.toLowerCase().includes('lead') || level.toLowerCase().includes('staff')) return '8+ years';
  if (level.toLowerCase().includes('principal')) return '10+ years';
  return 'See CV';
}

/**
 * Generate an Apply Data Card for a job.
 *
 * @param {object} job - Job object with { url, title, company, location, source }
 * @param {object} profile - Parsed config/profile.yml
 * @returns {{ markdown: string, telegram: string, jobId: string }}
 */
export function generateApplyCard(job, profile) {
  const { tier, type: atsType } = detectATS(job.url);
  const candidate = profile.candidate || {};
  const compensation = profile.compensation || {};
  const location = profile.location || {};
  const coverLetter = profile.cover_letter || {};
  const euWork = profile.eu_work_authorization || {};
  const { firstName, lastName } = splitName(candidate.full_name);
  const cvPath = findCvPdf(job.company);
  const jobId = extractJobId(job.url);
  const yearsExp = estimateYearsExperience(profile);

  // Determine work authorization answer
  const visaStatus = location.visa_status || euWork?.status || '';
  const needsSponsorship = euWork?.sponsorship_needed === true ||
    visaStatus.toLowerCase().includes('needs') ||
    visaStatus.toLowerCase().includes('sponsorship');
  const authAnswer = needsSponsorship ? 'Requires sponsorship' : 'Yes';
  const sponsorAnswer = needsSponsorship ? 'Yes' : 'No';

  // Detect the country from the job location or profile
  const jobCountry = job.location || location.country || 'the applicable country';

  // ── Build Markdown Card ───────────────────────────────────────────────────

  const lines = [];

  lines.push(`## Apply Data Card — ${job.company} ${job.title}`);
  lines.push('');
  lines.push('**Personal**');
  lines.push(`- Full name: ${candidate.full_name || '—'}`);
  lines.push(`- Email: ${candidate.email || '—'}`);
  lines.push(`- Phone: ${candidate.phone || '—'}`);
  lines.push(`- LinkedIn: ${candidate.linkedin || '—'}`);
  lines.push(`- GitHub: ${candidate.github || '—'}`);
  lines.push(`- Website: ${candidate.portfolio_url || '—'}`);
  lines.push('');
  lines.push('**Common questions (pre-answered)**');
  lines.push(`- "Are you authorized to work in ${jobCountry}?" → ${authAnswer}`);
  lines.push(`- "Years of experience?" → ${yearsExp}`);
  lines.push(`- "Expected salary?" → ${compensation.target_range || '—'}`);
  lines.push(`- "Notice period?" → ${coverLetter.notice_period_days ? `${coverLetter.notice_period_days} days` : '—'}`);
  lines.push(`- "Do you require visa sponsorship?" → ${sponsorAnswer}`);
  lines.push('');

  // Workday-specific section
  if (atsType === 'workday') {
    lines.push('**Workday Form Guide**');
    lines.push('Workday uses a multi-step form with consistent field names across all companies.');
    lines.push('');
    lines.push('*Step 1 — My Information*');
    for (const f of WORKDAY_FIELDS.personal) {
      let value = '—';
      if (f.profileKey === 'first_name') value = firstName;
      else if (f.profileKey === 'last_name') value = lastName;
      else if (f.profileKey === 'email') value = candidate.email || '—';
      else if (f.profileKey === 'phone') value = candidate.phone || '—';
      else if (f.profileKey === 'city') value = location.city || candidate.location?.split(',')[0]?.trim() || '—';
      else if (f.note) value = f.note;
      lines.push(`- ${f.field}: ${value}`);
    }
    lines.push('');

    lines.push('*Step 2 — My Experience*');
    for (const f of WORKDAY_FIELDS.experience) {
      lines.push(`- ${f.field}: ${f.note}`);
    }
    lines.push('');

    lines.push('*Step 4 — Voluntary Disclosures (all optional)*');
    for (const f of WORKDAY_FIELDS.selfId) {
      lines.push(`- ${f.field}: ${f.note}`);
    }
    lines.push('');

    lines.push('*Workday Tips*');
    for (const tip of WORKDAY_FIELDS.tips) {
      lines.push(`- ${tip.replace(/^💡\s*/, '')}`);
    }
    lines.push('');
  }

  lines.push(`**CV** → ${cvPath || 'Run pdf mode first'}`);
  lines.push(`**Apply URL** → ${job.url}`);
  lines.push('');

  const markdown = lines.join('\n');

  // ── Build Telegram Markdown Card ──────────────────────────────────────────

  const tg = [];
  const escapeMarkdown = (text) => {
    return String(text ?? '').replace(/([_*`\[])/g, '\\$1');
  };
  const escMd = (t) => escapeMarkdown(t);

  tg.push(`*📋 Apply Data Card — ${escMd(job.company)} ${escMd(job.title)}*`);
  tg.push(`_ATS: ${escMd(atsType)} (Tier ${tier})_`);
  tg.push('');

  tg.push('*Personal*');
  tg.push(`- Full name: ${escMd(candidate.full_name)}`);
  tg.push(`- Email: ${escMd(candidate.email)}`);
  tg.push(`- Phone: ${escMd(candidate.phone)}`);
  tg.push(`- LinkedIn: ${escMd(candidate.linkedin)}`);
  tg.push(`- GitHub: ${escMd(candidate.github)}`);
  tg.push(`- Website: ${escMd(candidate.portfolio_url)}`);
  tg.push('');

  tg.push('*Common questions (pre-answered)*');
  tg.push(`- "Are you authorized to work in ${escMd(jobCountry)}?" → ${escMd(authAnswer)}`);
  tg.push(`- "Years of experience?" → ${escMd(yearsExp)}`);
  tg.push(`- "Expected salary?" → ${escMd(compensation.target_range)}`);
  tg.push(`- "Notice period?" → ${coverLetter.notice_period_days ? `${coverLetter.notice_period_days} days` : '—'}`);
  tg.push(`- "Do you require visa sponsorship?" → ${escMd(sponsorAnswer)}`);
  tg.push('');

  if (atsType === 'workday') {
    tg.push('*Workday Form Guide*');
    tg.push('*Step 1 — My Information*');
    for (const f of WORKDAY_FIELDS.personal) {
      let value = '—';
      if (f.profileKey === 'first_name') value = firstName;
      else if (f.profileKey === 'last_name') value = lastName;
      else if (f.profileKey === 'email') value = candidate.email || '—';
      else if (f.profileKey === 'phone') value = candidate.phone || '—';
      else if (f.profileKey === 'city') value = location.city || candidate.location?.split(',')[0]?.trim() || '—';
      else if (f.note) value = f.note;
      tg.push(`- ${escMd(f.field)}: ${escMd(value)}`);
    }
    tg.push('');

    tg.push('*Step 2 — My Experience*');
    for (const f of WORKDAY_FIELDS.experience) {
      tg.push(`- ${escMd(f.field)}: ${escMd(f.note)}`);
    }
    tg.push('');

    tg.push('*Step 4 — Voluntary Disclosures*');
    for (const f of WORKDAY_FIELDS.selfId) {
      tg.push(`- ${escMd(f.field)}: ${escMd(f.note)}`);
    }
    tg.push('');

    tg.push('*Workday Tips*');
    for (const tip of WORKDAY_FIELDS.tips) {
      tg.push(`- ${escMd(tip.replace(/^💡\s*/, ''))}`);
    }
    tg.push('');
  }

  tg.push(`*CV* → ${escMd(cvPath || 'Run pdf mode first')}`);
  tg.push(`*Apply URL* → [Link](${job.url})`);

  const telegram = tg.join('\n');

  return { markdown, telegram, jobId };
}

// ── Save to Disk ──────────────────────────────────────────────────────────────

/**
 * Generate an apply card and save it to data/apply-cards/.
 *
 * @param {object} job - Job object
 * @returns {{ markdown: string, telegram: string, filePath: string, jobId: string }}
 */
export function generateAndSaveApplyCard(job) {
  const profile = loadProfile();
  const { markdown, telegram, jobId } = generateApplyCard(job, profile);

  mkdirSync(CARDS_DIR, { recursive: true });

  const fileName = `${jobId}.md`;
  const filePath = path.join(CARDS_DIR, fileName);

  writeFileSync(filePath, markdown, 'utf-8');

  return { markdown, telegram, filePath, jobId };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

import { pathToFileURL } from 'url';

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));

  if (!url) {
    console.error('Usage: node apply-card.mjs <url> [--company "Name"] [--title "Title"]');
    process.exit(1);
  }

  // Parse optional flags
  const getFlag = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const { tier, type: atsType } = detectATS(url);
  const job = {
    url,
    company: getFlag('company') || 'Unknown Company',
    title: getFlag('title') || 'Unknown Role',
    location: getFlag('location') || null,
    source: 'cli',
  };

  console.log(`\n🔍 Detected ATS: ${atsType} (Tier ${tier})\n`);

  if (tier === 1) {
    console.log('ℹ️  Tier 1 jobs can be auto-filled — an apply card is not usually needed.');
    console.log('   Generating anyway for reference...\n');
  }

  try {
    const { markdown, filePath } = generateAndSaveApplyCard(job);
    console.log(markdown);
    console.log(`\n✅ Card saved to: ${filePath}`);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}
