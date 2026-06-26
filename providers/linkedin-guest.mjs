// @ts-check
/**
 * linkedin-guest.mjs — LinkedIn public guest API provider.
 *
 * Uses LinkedIn's unauthenticated jobs-guest endpoint, the same one served
 * to search engines and anonymous visitors. No login, no cookies, no tokens.
 *
 * Legal note: hiQ Labs v. LinkedIn (9th Cir. 2022) confirmed scraping public
 * data does not violate the CFAA. This endpoint is publicly accessible without
 * authentication and is indexed by Google.
 *
 * Rate limiting: module-level gate enforces a 5–10 s jittered gap between all
 * LinkedIn requests across all board entries (they share one global gate).
 * LinkedIn rate-limits by IP; the worst case is a temporary 429, never an
 * account ban (no account is involved).
 *
 * Configuration (portals.eu.yml or portals.yml):
 *
 *   job_boards:
 *     - name: "LinkedIn — Backend Europe Remote"
 *       provider: linkedin-guest
 *       keywords: "backend engineer"
 *       location: "Europe"
 *       f_WT: "2"        # 1=on-site 2=remote 3=hybrid
 *       f_TPR: "r604800" # r86400=24h r604800=1wk r2592000=1mo
 *       f_JT: "F"        # F=full-time P=part-time C=contract
 *       f_E: "4"         # 1=intern 2=entry 3=associate 4=mid-senior 5=director
 *
 * Telegram interactive use:
 *   Import fetchLinkedInJobs() from this module into telegram-bot.mjs for
 *   the /linkedin command.
 */

// ── Rate gate ─────────────────────────────────────────────────────────────────
// All LinkedIn requests share a single module-level timer so that even when
// scan.mjs runs 6 board entries in parallel (CONCURRENCY=10), they're serialised
// and spaced 5–10 s apart.

let _nextAllowedMs = 0;
const RATE_MIN_MS = 5_000;
const RATE_MAX_MS = 10_000;

async function rateGate() {
  const now = Date.now();
  const wait = _nextAllowedMs - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _nextAllowedMs =
    Date.now() +
    RATE_MIN_MS +
    Math.floor(Math.random() * (RATE_MAX_MS - RATE_MIN_MS));
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GUEST_SEARCH_URL =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const MAX_RESULTS = 25; // first page only — no pagination

// Realistic headers that mimic an anonymous browser visit to the guest jobs page.
// LinkedIn checks these; a missing or bot-like UA gets a 429 or redirect to login.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.7",
  Referer: "https://www.linkedin.com/jobs/search/",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

// ── HTML helpers ──────────────────────────────────────────────────────────────

/** @param {string} s */
function decodeHtml(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Parse the HTML fragment returned by the guest search endpoint.
 * The response is a list of <li> elements; each contains a .base-card div
 * with class-name-based selectors for title, company, location, and URL.
 *
 * Selectors used (stable as of 2024-2026):
 *   Title    class="base-search-card__title"
 *   Company  class="base-search-card__subtitle" (may contain a nested <a>)
 *   Location class="job-search-card__location"
 *   URL      href="https://www.linkedin.com/jobs/view/..."
 *
 * No external DOM library — uses simple, targeted regex on the known HTML shape.
 *
 * @param {string} html
 * @param {string} fallbackCompany
 * @returns {{ title: string, url: string, company: string, location: string }[]}
 */
function parseGuestHtml(html, fallbackCompany) {
  const jobs = [];

  // Split by opening <li> tag to isolate each job card
  const items = html.split(/<li\b/i).slice(1);

  for (const item of items) {
    try {
      // Job URL — LinkedIn uses country-specific subdomains (pl., de., fr., www.)
      // Normalise to www.linkedin.com after extraction.
      const urlMatch = item.match(
        /href="(https:\/\/[a-z.-]*linkedin\.com\/jobs\/view\/[^"?]+)/,
      );
      if (!urlMatch) continue;
      // Strip tracking params and normalise to www.
      const rawUrl = urlMatch[1].split("?")[0];
      const url = rawUrl.replace(
        /^https:\/\/[a-z-]+\.linkedin\.com/,
        "https://www.linkedin.com",
      );

      // Title
      const titleMatch = item.match(
        /class="[^"]*base-search-card__title[^"]*"[^>]*>\s*([^<]+)/,
      );
      const title = titleMatch ? decodeHtml(titleMatch[1]) : "";
      if (!title) continue;

      // Company — may be inside a nested anchor: extract text content
      const companyRaw = item.match(
        /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/,
      );
      let company = fallbackCompany;
      if (companyRaw) {
        // Strip any nested tags (e.g. <a>Company Name</a>)
        company = decodeHtml(companyRaw[1].replace(/<[^>]+>/g, ""));
      }

      // Location
      const locationMatch = item.match(
        /class="[^"]*job-search-card__location[^"]*"[^>]*>\s*([^<]+)/,
      );
      const location = locationMatch ? decodeHtml(locationMatch[1]) : "";

      jobs.push({ title, url, company, location });
    } catch {
      // Skip malformed items silently — partial HTML is not unusual
    }
  }

  return jobs;
}

// ── URL builder ───────────────────────────────────────────────────────────────

/**
 * Build the guest API search URL from a portals.yml board entry.
 * Supported fields: keywords, location, geoId, f_WT, f_TPR, f_JT, f_E.
 *
 * @param {{ keywords?: string, location?: string, geoId?: string|number,
 *           f_WT?: string, f_TPR?: string, f_JT?: string, f_E?: string }} opts
 */
function buildSearchUrl(opts) {
  const p = new URLSearchParams({ start: "0" });
  if (opts.keywords) p.set("keywords", opts.keywords);
  if (opts.location) p.set("location", opts.location);
  if (opts.geoId) p.set("geoId", String(opts.geoId));
  if (opts.f_WT) p.set("f_WT", String(opts.f_WT));
  if (opts.f_TPR) p.set("f_TPR", String(opts.f_TPR));
  if (opts.f_JT) p.set("f_JT", String(opts.f_JT));
  if (opts.f_E) p.set("f_E", String(opts.f_E));
  return `${GUEST_SEARCH_URL}?${p.toString()}`;
}

// ── Public helper (used by telegram-bot.mjs /linkedin command) ────────────────

/**
 * Fetch LinkedIn job listings from the public guest API.
 * Can be imported directly by telegram-bot.mjs for interactive /linkedin queries.
 *
 * @param {string} keywords   e.g. "python developer poland"
 * @param {{ location?: string, f_WT?: string, f_TPR?: string, limit?: number }} [opts]
 * @returns {Promise<{ title: string, url: string, company: string, location: string }[]>}
 */
export async function fetchLinkedInJobs(
  keywords,
  { location = "", f_WT = "", f_TPR = "r604800", limit = 10 } = {},
) {
  await rateGate();

  const apiUrl = buildSearchUrl({ keywords, location, f_WT, f_TPR });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let html;
  try {
    const res = await fetch(apiUrl, {
      headers: HEADERS,
      signal: controller.signal,
    });
    if (res.status === 429) {
      throw new Error(
        "linkedin-guest: rate-limited (429) — try again in a few minutes",
      );
    }
    if (!res.ok) {
      throw new Error(`linkedin-guest: HTTP ${res.status}`);
    }
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  // LinkedIn sometimes returns a redirect-to-login page (very short HTML)
  if (html.length < 500 && html.includes("login")) {
    throw new Error(
      "linkedin-guest: received login redirect — IP may be temporarily rate-limited",
    );
  }

  return parseGuestHtml(html, "LinkedIn").slice(0, limit);
}

// ── Provider export (auto-discovered by scan.mjs) ─────────────────────────────

/** @type {import('./_types.js').Provider} */
export default {
  id: "linkedin-guest",

  /**
   * This provider is always selected explicitly via `provider: linkedin-guest`
   * in portals.yml — it never auto-detects from a URL.
   */
  detect(_entry) {
    return null;
  },

  /**
   * Fetch jobs for one board entry. Called by scan.mjs for each job_boards
   * entry that has `provider: linkedin-guest`.
   *
   * @param {import('./_types.js').PortalEntry} entry
   * @param {{ fetchText: Function }} ctx
   */
  async fetch(entry, ctx) {
    const apiUrl = buildSearchUrl(/** @type {any} */ (entry));

    // Enforce global rate gate before every LinkedIn request
    await rateGate();

    let html;
    try {
      html = await ctx.fetchText(apiUrl, {
        headers: HEADERS,
        timeoutMs: 15_000,
      });
    } catch (err) {
      if (/** @type {any} */ (err).status === 429) {
        throw new Error(
          "linkedin-guest: rate-limited (429) — reduce scan frequency",
        );
      }
      throw err;
    }

    if (html.length < 500 && html.includes("login")) {
      throw new Error(
        "linkedin-guest: login redirect received — IP rate-limited",
      );
    }

    const jobs = parseGuestHtml(html, entry.name || "LinkedIn");
    return jobs.slice(0, MAX_RESULTS);
  },
};
