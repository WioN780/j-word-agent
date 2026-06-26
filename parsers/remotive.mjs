// @ts-check
/**
 * Remotive category-filtered parser.
 *
 * Unlike the existing providers/remotive.mjs (which fetches the full feed and
 * lets title_filter gate), this parser accepts a `category` field on the
 * portals entry and fetches only that slice of the Remotive API — reducing
 * network payload and improving precision.
 *
 * If `entry.category` is absent, it falls back to the full feed.
 *
 * Wire in via scan.mjs EU-FORK block:
 *   providers.set('remotive-cat', makeRemotiveCatProvider())
 *
 * portals.eu.yml entry shape:
 *   - name: Remotive Software Dev
 *     careers_url: https://remotive.com/api/remote-jobs
 *     provider: remotive-cat
 *     category: software-dev
 *     enabled: true
 *
 * Valid categories (as of 2025):
 *   software-dev, devops-sysadmin, data, machine-learning, product,
 *   design, finance, marketing, customer-support, business, hr, qa,
 *   writing, legal, sales
 */

const FEED_URL = 'https://remotive.com/api/remote-jobs';

export function makeRemotiveCatProvider() {
  return {
    id: 'remotive-cat',

    // No auto-detection; requires explicit `provider: remotive-cat`.
    detect() { return null; },

    async fetch(entry, ctx) {
      const category = entry.category ? String(entry.category).trim() : null;
      const url = category ? `${FEED_URL}?category=${encodeURIComponent(category)}` : FEED_URL;

      // redirect:'error' prevents SSRF via server-side redirects (mirrors remotive.mjs).
      const json = await ctx.fetchJson(url, { redirect: 'error' });

      if (!json || !Array.isArray(json.jobs)) {
        throw new Error(
          `remotive-cat(${category ?? 'all'}): unexpected response — expected { jobs: [...] }, got keys: [${
            json ? Object.keys(json).join(', ') : 'null'
          }]`,
        );
      }

      return json.jobs
        .filter(
          j =>
            j &&
            typeof j === 'object' &&
            typeof j.title === 'string' &&
            j.title.trim() !== '' &&
            typeof j.url === 'string' &&
            /^https?:\/\//i.test(j.url.trim()),
        )
        .map(j => ({
          title:    j.title.trim(),
          url:      j.url.trim(),
          company:  (typeof j.company_name === 'string' && j.company_name.trim())
                      ? j.company_name.trim()
                      : (entry.name || 'Remotive'),
          location: typeof j.candidate_required_location === 'string'
                      ? j.candidate_required_location.trim()
                      : '',
        }));
    },
  };
}
