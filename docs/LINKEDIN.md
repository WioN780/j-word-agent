# LinkedIn Job Search — Research Findings & Implementation

## TL;DR

| Option | Status | Implementation |
|---|---|---|
| RSS feed | ❌ Dead since 2013 | N/A |
| Official API | ❌ Partner-only, not available | N/A |
| **Guest API (Option B)** | ✅ **Working, no login** | `providers/linkedin-guest.mjs` |
| **Telegram /linkedin (Option C)** | ✅ **Working, on-demand** | `telegram-bot.mjs` |

---

## Research Findings

### LinkedIn RSS (investigated, rejected)

LinkedIn removed all public RSS support in 2013 as part of a broader API lockdown. No official endpoint exists for profiles, jobs, company pages, or newsletters. Third-party services (RSS.app, etc.) that advertise LinkedIn RSS feeds are scrapers that scrape the web UI on your behalf — they work until LinkedIn's next change and violate LinkedIn's ToS. They are not appropriate for a production pipeline.

**Decision: No RSS implementation.**

### LinkedIn Official API (investigated, rejected)

LinkedIn's official job posting API requires joining the LinkedIn Partner Program (application-based, typically for recruitment software companies). Access is not available for personal tools. The API Terms of Use explicitly prohibit scraping via the official API path.

**Decision: No official API implementation.**

### LinkedIn Guest API (implemented ✅)

LinkedIn exposes a public, unauthenticated search endpoint to serve job listings to anonymous visitors and search engine crawlers. This is the same data that appears when you visit `linkedin.com/jobs` without logging in, or when Google indexes LinkedIn job postings.

**Endpoint:**
```
GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
  ?keywords=python+developer
  &location=Poland
  &f_WT=2          # remote
  &f_TPR=r604800   # past week
  &start=0
```

**What it returns:** Raw HTML fragments — `<li>` elements each containing a job card. Parsed with regex (no external library needed).

**Authentication:** None. No cookies, no tokens, no OAuth.

**Legal status:** The hiQ Labs v. LinkedIn ruling (9th Circuit, 2022) confirmed that scraping publicly accessible data does not violate the Computer Fraud and Abuse Act. LinkedIn's ToS technically prohibit scraping, but enforcement is IP-level for anonymous traffic (temporary 429 blocks), never account-level (no account is involved here).

**Practical risk:** Low for personal/low-volume use. The implementation uses 5–10 s jittered delays, first page only (25 results max per query), and no pagination. This is well within normal browsing behaviour.

**Decision: Implemented as Option B (provider) + Option C (Telegram command).**

---

## Architecture

The guest API is implemented in two places:

```
providers/linkedin-guest.mjs  ← auto-discovered by scan.mjs (Option B)
telegram-bot.mjs              ← /linkedin command (Option C)
```

Both use the same `fetchLinkedInJobs()` function from the provider module.

**Zero changes to `scan.mjs`** — scan.mjs auto-discovers all `*.mjs` files in `providers/` at startup. Adding the provider file is sufficient.

---

## Rate Limiting Strategy

A module-level gate serialises all LinkedIn requests across all board entries:

```
Request 1 fires at T+0
Request 2 fires at T+0 + jitter(5–10s)  ← waits for gate
Request 3 fires at T+0 + 2×jitter        ← waits for gate
...
```

With 6 EU search queries, the full LinkedIn scan takes ~45–75 seconds. This is acceptable for a twice-daily autonomous scan.

**429 handling:** If LinkedIn returns 429, the provider throws a descriptive error. The scheduler's circuit breaker catches 3 consecutive full-scan failures and pauses. For one-off 429s (single board entry), the error is logged and the scan continues with other entries.

---

## Setup

### Option B — Automated scan via portals.yml

Copy the queries you want from `portals.linkedin.yml` into your `portals.eu.yml`:

```yaml
# portals.eu.yml
job_boards:
  # ... your existing EU boards ...

  - name: "LinkedIn — Backend Engineer Warsaw Remote"
    provider: linkedin-guest
    keywords: "backend engineer remote"
    location: "Warsaw, Poland"
    geoId: "105072130"
    f_WT: "2"
    f_TPR: "r604800"
    f_JT: "F"
    enabled: true
```

Run a scan:
```bash
node scan.mjs --notify
# or via scheduler:
node scheduler.mjs --once
```

scan.mjs will include LinkedIn results alongside all other providers.

### Option C — On-demand Telegram command

Message your bot:
```
/linkedin python developer poland
/linkedin backend engineer berlin remote
/linkedin ml engineer amsterdam
/linkedin software engineer europe remote
```

The bot fetches from the guest API and sends a formatted list of up to 10 results with direct job links. No Playwright, no login, no browser required.

**Note:** The `/linkedin` command is available in `telegram-bot.mjs`'s standalone listener mode. Run `node telegram-bot.mjs` alongside your scheduler, or use the scheduler's built-in Telegram listener (daemon mode handles this automatically when `notify` stage is enabled).

---

## Query Parameters Reference

| Parameter | Values | Description |
|---|---|---|
| `keywords` | any string | Job title, skills, company name |
| `location` | city/country name | e.g. `"Europe"`, `"Poland"`, `"Berlin, Germany"` |
| `geoId` | numeric string | LinkedIn's internal geo ID (more precise than location text) |
| `f_WT` | `1` `2` `3` | Work type: 1=on-site, 2=remote, 3=hybrid |
| `f_TPR` | `r86400` `r604800` `r2592000` | Time posted: 24h, 1wk, 1mo |
| `f_JT` | `F` `P` `C` `T` `I` | Job type: Full-time, Part-time, Contract, Temporary, Internship |
| `f_E` | `1`–`6` | Experience: 1=intern, 2=entry, 3=associate, 4=mid-senior, 5=director, 6=exec |

### Common geoIds for EU markets

| Location | geoId |
|---|---|
| Poland | `105072130` |
| Germany | `101282230` |
| Berlin | `106967730` |
| Warsaw | `105072130` |
| Netherlands | `102890719` |
| Amsterdam | `102011674` |
| United Kingdom | `101165590` |
| London | `90009496` |
| France | `105015875` |
| Sweden | `105117694` |
| Europe (broad) | `91000002` |
| Remote (worldwide) | *(use `f_WT: "2"` + no geoId)* |

---

## Pre-configured EU Queries

`portals.linkedin.yml` contains 6 ready-to-use search configurations (copy into `portals.eu.yml` to activate):

| Entry name | Keywords | Location | Remote? |
|---|---|---|---|
| Software Engineer Europe Remote | software engineer europe remote | Europe | Yes |
| Backend Engineer Warsaw Remote | backend engineer remote | Warsaw, Poland | Yes |
| Python Developer Poland | python developer | Poland | Any |
| Data Engineer Berlin Remote | data engineer remote | Berlin, Germany | Yes |
| DevOps Engineer UK Remote | devops engineer remote | United Kingdom | Yes |
| ML Engineer Amsterdam | machine learning engineer | Amsterdam, Netherlands | Any |

---

## What Option C (Playwright) Would Look Like

The task spec suggested opening LinkedIn search URLs in Playwright. This is technically possible but comes with significant drawbacks:

- LinkedIn detects Playwright's Chromium and frequently shows CAPTCHA or redirects to login for non-logged-in automation
- Playwright on RPi uses 300–500 MB RAM per instance
- Display requirement (needs Xvfb on headless RPi)
- Slower (full browser launch vs. HTTP request)

Since the guest API provides the same data without any of these complications, the `/linkedin` Telegram command uses the guest API instead. If the guest API ever fails (IP block, endpoint change), a Playwright fallback could be added, but it is not implemented by default.

---

## Limitations

| Limitation | Impact |
|---|---|
| First page only (25 results max per query) | Use specific keywords to stay relevant |
| HTML parsing (not JSON) | Fragile to LinkedIn front-end changes; will need updating if selectors change |
| No job description | The guest listing endpoint only returns title, company, location, URL |
| No applicant count | Available only to logged-in users |
| IP rate limiting | If running from a shared IP (cloud VM), you may hit 429 more often than on home/RPi |
| ToS | LinkedIn's ToS technically prohibit scraping even of public data; enforce at IP level only |

---

## Updating the Parser

LinkedIn occasionally changes the CSS class names used in the guest API's HTML response. If jobs stop appearing, check the selectors in `providers/linkedin-guest.mjs`:

```javascript
// These are the key selectors (class substring matching):
// Title:    class="base-search-card__title"
// Company:  class="base-search-card__subtitle"
// Location: class="job-search-card__location"
// URL:      href="https://www.linkedin.com/jobs/view/..."
```

To debug, fetch the raw HTML directly:
```bash
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36" \
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=python+developer&location=Poland&start=0" \
  | head -200
```

If the HTML structure has changed, update the regex patterns in `parseGuestHtml()`.

---

## Files Added

| File | Purpose |
|---|---|
| `providers/linkedin-guest.mjs` | Provider + `fetchLinkedInJobs()` shared function |
| `portals.linkedin.yml` | Template with 6 EU queries (copy into `portals.eu.yml` to activate) |
| `docs/LINKEDIN.md` | This file |
| `telegram-bot.mjs` | `/linkedin` command added to `startListener()` |
