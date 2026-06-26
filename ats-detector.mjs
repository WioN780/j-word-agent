#!/usr/bin/env node
/**
 * ats-detector.mjs — Detect ATS type and apply automation tier from a job URL.
 *
 * Tier semantics:
 *   1 — Full auto-fill  (Greenhouse, Ashby, Lever — structured API + known form layout)
 *   2 — Partial auto-fill (Workday — API exists but form is complex/dynamic)
 *   3 — Manual apply    (Taleo, iCIMS, SuccessFactors, unknown/custom portals)
 *
 * Detection is URL-only (hostname matching). No network requests are made.
 * For unknown hostnames the function returns tier 3 synchronously — callers that
 * want a deeper DOM check can optionally call detectATSFromDom() if Playwright is
 * available, but the scan path intentionally stays zero-token.
 */

const PATTERNS = [
  { hostname: 'greenhouse.io', tier: 1, type: 'greenhouse' },
  { hostname: 'ashbyhq.com', tier: 1, type: 'ashby' },
  { hostname: 'lever.co', tier: 1, type: 'lever' },
  { hostname: 'myworkdayjobs.com', tier: 2, type: 'workday' },
  { hostname: 'taleo.net', tier: 3, type: 'taleo' },
  { hostname: 'icims.com', tier: 3, type: 'icims' },
  { hostname: 'successfactors.com', tier: 3, type: 'successfactors' },
];

/**
 * Detect ATS from a job posting URL.
 * @param {string} url
 * @returns {{ tier: 1|2|3, type: string }}
 */
export function detectATS(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const { hostname, tier, type } of PATTERNS) {
      if (host === hostname || host.endsWith(`.${hostname}`)) {
        return { tier, type };
      }
    }
  } catch { /* invalid URL — fall through */ }
  return { tier: 3, type: 'unknown' };
}
