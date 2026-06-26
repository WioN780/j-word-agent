// @ts-check
/**
 * NoFluffJobs parser — uses the public JSON search API.
 *
 * NoFluffJobs is a Poland-focused job board (UK/DE return 0 results).
 * Scope: Polish in-office jobs + fully-remote jobs listed on the PL portal
 * (remote jobs are accessible from anywhere in Europe).
 *
 * API quirks:
 * - `salaryCurrency` and `salaryPeriod` are required query params (otherwise 400)
 * - Combined multi-category queries return ~87 "best of all" postings per page;
 *   single-category queries return 200+ per page. Use one entry per category.
 * - Each job is posted once per eligible city; dedup collapses multi-city variants
 *   into one entry, preferring the remote URL when available.
 *
 * Wire in via scan.mjs EU-FORK block:
 *   providers.set('nofluffjobs', makeNoFluffJobsProvider())
 *
 * portals.eu.yml entry shape (one category per entry for best coverage):
 *   - name: NoFluffJobs · Backend
 *     careers_url: https://nofluffjobs.com/pl/jobs
 *     provider: nofluffjobs
 *     nfj_categories: [backend]
 *     enabled: true
 *
 *   - name: NoFluffJobs · Remote Tech
 *     careers_url: https://nofluffjobs.com/pl/jobs
 *     provider: nofluffjobs
 *     nfj_categories: [backend, devops, artificial-intelligence, data]
 *     nfj_remote: true   # filter: fullyRemote only
 *     enabled: true
 *
 * Valid category slugs (selected tech):
 *   backend, devops, fullstack, artificial-intelligence, data,
 *   frontend, testing, security, mobile, big-data, embedded
 */

const NFJ_API =
  'https://nofluffjobs.com/api/search/posting?salaryCurrency=PLN&salaryPeriod=month&region=pl&language=pl-PL';
const NFJ_JOB_BASE = 'https://nofluffjobs.com/pl/job/';
const DEFAULT_CATEGORIES = ['backend', 'devops', 'fullstack', 'artificial-intelligence', 'data'];

export function makeNoFluffJobsProvider() {
  return {
    id: 'nofluffjobs',

    // No auto-detection; requires explicit `provider: nofluffjobs` in portals entry.
    detect() { return null; },

    async fetch(entry, ctx) {
      const categories =
        Array.isArray(entry.nfj_categories) && entry.nfj_categories.length > 0
          ? entry.nfj_categories.map(String)
          : DEFAULT_CATEGORIES;

      const criteriaSearch = { category: categories };
      if (entry.nfj_remote) criteriaSearch.more = ['remote'];

      const maxPages = typeof entry.nfj_pages === 'number' && entry.nfj_pages > 0
        ? Math.round(entry.nfj_pages)
        : 1;

      const seenUrl = new Set();
      // NFJ posts the same job for each eligible city — deduplicate by title+company,
      // preferring the remote variant over any city-specific URL.
      const byKey = new Map(); // `${title}|${company}` → job

      for (let page = 1; page <= maxPages; page++) {
        const json = await ctx.fetchJson(NFJ_API, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
            'origin': 'https://nofluffjobs.com',
          },
          body: JSON.stringify({ criteriaSearch, page, pageSize: 100 }),
          timeoutMs: 20_000,
        });

        if (!json || !Array.isArray(json.postings)) {
          throw new Error(
            `nofluffjobs: unexpected response — expected { postings: [...] }, got keys: [${
              json ? Object.keys(json).join(', ') : 'null'
            }]`,
          );
        }

        for (const p of json.postings) {
          if (!p || typeof p.title !== 'string' || typeof p.url !== 'string') continue;
          const url = NFJ_JOB_BASE + p.url;
          if (seenUrl.has(url)) continue;
          seenUrl.add(url);

          const title   = p.title.trim();
          const company = typeof p.name === 'string' && p.name.trim()
                            ? p.name.trim()
                            : (entry.name || 'NoFluffJobs');
          const isRemote = Boolean(p.location?.fullyRemote);
          const location = isRemote
                            ? 'Remote'
                            : (p.location?.places?.find(pl => pl?.city?.trim())?.city?.trim() || 'Poland');
          const job = { title, url, company, location };

          const key = `${title}|${company}`;
          if (!byKey.has(key)) {
            byKey.set(key, job);
          } else if (isRemote && byKey.get(key).location !== 'Remote') {
            // Upgrade existing city-specific entry to its remote variant
            byKey.set(key, job);
          }
        }

        if (page >= (json.totalPages ?? 1)) break;
      }

      return [...byKey.values()];
    },
  };
}
