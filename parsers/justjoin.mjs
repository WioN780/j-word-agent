// @ts-check
/**
 * JustJoin.it parser — XML sitemap approach.
 *
 * The public REST API (justjoin.it/api/offers) was shut down ~2024.
 * This parser reads the active-jobs XML sitemap instead, following the
 * justjoin.it → public.justjoin.com redirect chain automatically.
 * It derives title/company/location from the URL slug via heuristics.
 *
 * Data quality note: slug-derived metadata is approximate. scan.mjs's
 * title_filter runs against the slug-derived title, which reliably contains
 * tech-stack keywords ("python", "react", "senior", "engineer", etc.).
 *
 * Wire in via scan.mjs EU-FORK block:
 *   providers.set('justjoin', makeJustJoinProvider())
 */

const SITEMAP_INDEX = 'https://justjoin.it/sitemaps/active-jobs.xml';
const SITEMAP_TIMEOUT_MS = 30_000; // large XML files

// Words that mark the beginning of a job title in the slug.
// Seniority words almost always appear before the role name.
const SENIORITY = new Set([
  'junior', 'mid', 'senior', 'lead', 'head', 'staff', 'principal',
  'associate', 'entry', 'intern', 'internship', 'graduate', 'regular', 'medior',
]);

// Role words that can also appear as the first title word (no seniority prefix).
const ROLE_STARTS = new Set([
  'developer', 'engineer', 'architect', 'designer', 'analyst', 'scientist',
  'researcher', 'manager', 'director', 'consultant', 'specialist',
  'devops', 'sre', 'qa', 'tester',
  'frontend', 'backend', 'fullstack', 'mobile', 'ios', 'android',
  'security', 'cloud', 'site', 'data', 'ai', 'ml',
  'product', 'ux', 'ui', 'marketing', 'sales', 'recruiter', 'hr',
]);

// Polish city names that often appear at the end of slugs.
const PL_CITIES = new Set([
  'warszawa', 'krakow', 'wroclaw', 'poznan', 'gdansk', 'katowice',
  'lodz', 'lublin', 'bydgoszcz', 'szczecin', 'gdynia', 'rzeszow',
  'bialystok', 'torun', 'czestochowa', 'sosnowiec', 'radom',
  'olsztyn', 'opole', 'gdynia', 'remote', 'poland',
]);

/** Capitalize the first letter of a word. */
function cap(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Parse `<loc>…</loc>` elements from sitemap XML.
 * Uses a simple regex — no need for a full XML parser for this structure.
 */
function extractLocs(xml) {
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(m[1].trim());
  return locs;
}

/**
 * Derive structured job metadata from a JustJoin slug.
 *
 * Slug format (approximately): {company-words}-{seniority?}-{role-words}-{city?}
 * Empty segments from double-hyphens (e.g., `f-m--`) are dropped.
 */
function parseSlug(slug) {
  const all = slug.split('-').filter(Boolean);

  // Find the index of the first seniority or role-start word.
  let splitIdx = -1;
  for (let i = 0; i < all.length; i++) {
    if (SENIORITY.has(all[i]) || ROLE_STARTS.has(all[i])) {
      splitIdx = i;
      break;
    }
  }

  let companyWords, titleWords;
  if (splitIdx <= 0) {
    // No seniority/role word found; use first 2 words as company, rest as title.
    companyWords = all.slice(0, Math.min(2, all.length));
    titleWords = all.slice(companyWords.length);
  } else {
    companyWords = all.slice(0, splitIdx);
    titleWords = all.slice(splitIdx);
  }

  // Strip city from the end of titleWords (single-word city check only).
  let location = 'Poland';
  for (let i = titleWords.length - 1; i >= 0; i--) {
    if (PL_CITIES.has(titleWords[i])) {
      location = cap(titleWords[i]);
      titleWords = titleWords.slice(0, i);
      break;
    }
    // Stop scanning backwards once we hit a non-short word that is not a city.
    if (titleWords[i].length > 3 && !PL_CITIES.has(titleWords[i])) break;
  }

  const company = companyWords.length ? companyWords.map(cap).join(' ') : 'JustJoin';
  const title   = titleWords.length  ? titleWords.map(cap).join(' ')   : slug;

  return { company, title, location };
}

export function makeJustJoinProvider() {
  return {
    id: 'justjoin',

    // No auto-detection; requires explicit `provider: justjoin` in portals entry.
    detect() { return null; },

    async fetch(entry, ctx) {
      // Step 1: fetch sitemap index (justjoin.it → public.justjoin.com redirect).
      let indexXml;
      try {
        indexXml = await ctx.fetchText(SITEMAP_INDEX, { timeoutMs: SITEMAP_TIMEOUT_MS });
      } catch (err) {
        throw new Error(`justjoin: failed to fetch sitemap index: ${err.message}`);
      }

      // Step 2: parse part file URLs from the <sitemapindex>.
      let partUrls = extractLocs(indexXml).filter(u => u.includes('/sitemaps/') || u.includes('sitemap'));

      // If the index itself is a <urlset> (single-file sitemap), parse it directly.
      if (partUrls.length === 0 || !indexXml.includes('<sitemapindex')) {
        const jobUrls = extractLocs(indexXml).filter(u => u.includes('/job-offer/'));
        if (jobUrls.length > 0) {
          return jobUrls.map(url => ({ url, ...parseSlug(url.split('/job-offer/')[1] || url) }));
        }
        throw new Error('justjoin: sitemap index had no part URLs and no job URLs');
      }

      // Step 3: fetch each part file and collect job URLs.
      const jobUrls = [];
      for (const partUrl of partUrls) {
        let partXml;
        try {
          partXml = await ctx.fetchText(partUrl, { timeoutMs: SITEMAP_TIMEOUT_MS });
        } catch (err) {
          // Non-fatal — log and continue with other parts.
          console.error(`justjoin: skipped part ${partUrl}: ${err.message}`);
          continue;
        }
        const locs = extractLocs(partXml).filter(u => u.includes('/job-offer/'));
        jobUrls.push(...locs);
      }

      if (jobUrls.length === 0) {
        throw new Error('justjoin: no /job-offer/ URLs found in any sitemap part');
      }

      return jobUrls.map(url => ({ url, ...parseSlug(url.split('/job-offer/')[1] || url) }));
    },
  };
}
