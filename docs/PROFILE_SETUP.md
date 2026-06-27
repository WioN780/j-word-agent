# Profile Setup Guide

How to fill in the personal files that make career-ops work for you. The system is ready to use once these are in place — everything else (modes, scripts, templates) is pre-configured.

For installation and dependencies, see [SETUP.md](SETUP.md). For archetype and portal customization, see [CUSTOMIZATION.md](CUSTOMIZATION.md).

---

## Files You Need to Fill In

Listed in priority order. The system blocks evaluations until the first three exist.

| File | Priority | What it is |
|------|----------|-----------|
| `cv.md` | **Required** | Your canonical CV — the AI reads this before every evaluation |
| `config/profile.yml` | **Required** | Your identity, targets, and compensation — the single source of truth |
| `modes/_profile.md` | **Required** | Your archetype framing, negotiation scripts, and location policy |
| `portals.yml` | Recommended | Job portals to scan; copy from `templates/portals.example.yml` |
| `article-digest.md` | Optional | Compact proof points from blog posts, case studies, or projects |
| `projects.md` | Optional | Your full project pool — AI selects 2-3 per application |

The AI copies `modes/_profile.template.md` → `modes/_profile.md` on first run if it is missing, so you rarely need to create it by hand.

---

## config/profile.yml — Field Reference

### candidate

| Field | Used for | Required |
|-------|----------|----------|
| `full_name` | CV header, cover letter salutation, report metadata | Yes |
| `email` | CV header, application form answers | Yes |
| `phone` | CV header; omit if you prefer not to share | No |
| `location` | Remote/hybrid scoring in Block A and D; cover letter context | Yes |
| `linkedin` | CV header, outreach messages, apply form answers | No |
| `portfolio_url` | PDF Professional Summary (always included for relevant roles), cover letter | No |
| `github` | CV header, apply form answers | No |
| `photo` | PDF CV header (DACH/EU markets only — leave empty for US/UK ATS) | No |

### target_roles

| Field | Used for |
|-------|---------|
| `primary` | Displayed in evaluations; used to detect seniority mismatch in Block C |
| `archetypes[].name` | Read by `modes/_profile.md` to select proof points and framing |
| `archetypes[].fit` | `primary` / `secondary` / `adjacent` — adjusts North Star score in Block B |

**To change your target roles:** edit both `target_roles` here and the archetype table in `modes/_profile.md`. They should agree.

### narrative

| Field | Used for |
|-------|---------|
| `headline` | PDF Professional Summary first line; cover letter context |
| `exit_story` | Cover letter opening paragraph framing; interview prep |
| `superpowers` | Cover letter bullets; used when generating `/career-ops cover` |
| `proof_points[].hero_metric` | Block E customization plan; PDF summary stat line |

**Rule:** Every metric in `narrative.proof_points` should match a real number in `cv.md` or `article-digest.md`. The AI checks for consistency.

### compensation

| Field | Used for |
|-------|---------|
| `target_range` | Block D comp comparison; negotiation script defaults |
| `minimum` | Walk-away floor — never disclosed automatically; used internally for score penalising below-market offers |
| `currency` | Ensures correct currency when comparing EUR/GBP/PLN vs USD salaries |

### location

| Field | Used for |
|-------|---------|
| `visa_status` | Hard-filter in Block B when JD says "no sponsorship"; EU modes read this |
| `timezone` | Scoring remote roles that require specific overlap |

### cover_letter

| Field | Used for |
|-------|---------|
| `notice_period_days` | Default value when application forms ask "earliest start date" |
| `primary_domain` | Domain gap detection — if JD domain differs significantly from this, flagged in Block E |
| `language_learning` | Optional closing sentence in the JD's language if location matches the country list |

### EU fields (commented out by default)

Uncomment the `eu_*` blocks when targeting EU/EEA/UK roles. The `eu-backend`, `eu-ml`, and `eu-devops` calibration modes read them during hard-filter checks. See [EU Archetype Extensions](../AGENTS.md) for the full detection logic.

---

## cv.md — Writing Guide

The AI reads `cv.md` **before every evaluation**. It maps your experience to JD requirements in Block B and pulls exact lines to cite in cover letters and PDF summaries. Specificity is the only thing that matters here.

### What makes a good bullet

```
# Weak — tells the AI nothing it can cite
- Worked on backend services

# Strong — gives the AI a real claim to map and a metric to quote
- Rebuilt the order processing service in Go, cutting p99 latency from 2.1 s to 380 ms
  and eliminating the manual retry queue (previously 200+ ops hours/month)
```

### Section guidance

| Section | Notes |
|---------|-------|
| **Summary** | 3-5 sentences. The AI rewrites this per application — your version is the raw material. Lead with your strongest, most specific claim. |
| **Experience** | Reverse-chronological. 3-5 bullets per role. Every bullet = action verb + what you did + measurable result. |
| **Skills** | Exact tool and framework names — these are used for ATS keyword matching. Only list what you can be interviewed on. |
| **Projects** | Keep minimal or empty here — the AI selects from `projects.md` per application. Only add a project here if it should appear on every CV regardless of the JD. |
| **Languages** | Include level (Native / C1 / B2 / etc.). EU calibration modes check this against JD language requirements. |

---

## projects.md — Project Pool Selection

`projects.md` is a pool of your portfolio projects. When generating a tailored CV, the AI selects the 2-3 that best match the job description — not all of them, and not always the same ones.

### How selection works

1. The AI extracts keywords from the JD: stack terms, domain keywords, tool names.
2. Each project is scored by counting matches against its `Stack tags`, `Domain tags`, and `Keywords` fields.
3. The top 2-3 by score are selected. If the third project has weak overlap, only 2 are included.
4. The AI logs its selection reasoning in the evaluation report.

### Project entry format

```markdown
## Project Name

**Description:** One sentence. What it is and why it exists.

**Stack tags:** Comma-separated exact tool names (Python, FastAPI, PostgreSQL, Docker)

**Domain tags:** Comma-separated domain words (backend, data-pipeline, ML, DevOps)

**Impact:** 2-4 sentences with real metrics. What scale, what improvement, what outcome.
           This is what gets quoted in CVs and cover letters — be specific.

**Keywords:** Broader keyword list for matching. Repeat important terms.
              Include synonyms the JD might use (e.g. "vector search, FAISS, embedding retrieval").

**Link:** https://github.com/yourhandle/repo (or live URL)
```

### How to add a new project

1. Open `projects.md`.
2. Add a `---` separator after the last entry.
3. Copy the format above and fill in all fields.
4. Use **exact tool names** in Stack tags (e.g. `FastAPI` not `Python REST framework`).
5. Write the Impact using real numbers from your actual work.

### Tips for better selection

- **Be keyword-specific in Stack tags.** `NestJS` matches a JD that says "NestJS"; `Node.js framework` does not.
- **Domain tags are for role-family routing.** Use `ML`, `DevOps`, `frontend`, `data-pipeline`, `backend`, `IoT` etc.
- **Keywords duplicate and extend Stack tags** with synonyms the JD might use. More coverage = better scoring.
- **Impact is what gets quoted.** If the metric is vague, the AI has nothing to cite. "Reduced deployment time" is weak; "Reduced deployment time from 45 minutes to 4 minutes via parallel pipeline stages" is what lands.

---

## modes/_profile.md — Archetype and Narrative

This file tells the system how to frame your experience for each role archetype. The AI reads it after `_shared.md` — your settings here override system defaults.

Key sections to fill in:

| Section | What to do |
|---------|-----------|
| **Your Target Roles** | Replace the example archetype table with YOUR target roles and what you offer each |
| **Your Adaptive Framing** | Map your specific projects to each archetype — "if the role is ML Engineer, emphasize X project" |
| **Your Exit Narrative** | Your transition story framed per archetype |
| **Your Comp Targets** | Replace with real numbers from your `compensation` block |
| **Your Negotiation Scripts** | Adapt the scripts to your situation, currency, and location |
| **Your Location Policy** | How you handle hybrid/remote offers in scoring |

---

<!-- EU-FORK START -->
## Scheduler Prerequisites

The autonomous scheduler (`node scheduler.mjs --daemon`) requires environment variables beyond the base setup:

| Variable | Required for | Notes |
|----------|-------------|-------|
| `GEMINI_API_KEY` | Eval stage | Scores new jobs with `gemini-2.5-flash`. Without this, the eval stage is silently skipped. |
| `TELEGRAM_BOT_TOKEN` | All Telegram notifications | Get from @BotFather |
| `TELEGRAM_CHAT_ID` | All Telegram notifications | Get from @userinfobot |

**Live portfolio sync:** The scheduler fetches your current projects and CV PDF from `markooba.com/api/{lang}/` once per scan cycle. The data is used to tailor CV generation — it does NOT overwrite `cv.md` or `projects.md`. If the API is unreachable, the scheduler falls back to `data/projects-cache.md` (last successful fetch), then to your local `projects.md`.

Add these to your `.env` file alongside `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
<!-- EU-FORK END -->

## Checklist — Before Your First Evaluation

```
[ ] config/profile.yml     — fill in candidate, target_roles, narrative, compensation, location
[ ] cv.md                  — your real experience, metrics, and skills
[ ] modes/_profile.md      — your archetype framing and negotiation scripts
[ ] portals.yml            — copy from templates/portals.example.yml, adjust title_filter keywords
[ ] projects.md            — add your real projects (replace or supplement the placeholders)
[ ] article-digest.md      — optional; add if you have blog posts or case studies with metrics
```

Once all six files exist, run the health check:

```bash
node doctor.mjs --json
```

If `onboardingNeeded` is `false`, you are ready. Paste a job URL or description and the pipeline runs.
