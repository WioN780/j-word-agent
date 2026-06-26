# Mode: eu-backend — EU Backend / Fullstack Application Calibration

Use when targeting backend, fullstack, or API-focused roles at EU/EEA/UK companies. Layer on top of the standard A–G evaluation — it adds EU market calibration, not a separate flow.

For work-authorization, language, and country-specific legal facts that apply across all EU SWE roles, defer to `modes/regional/eu-swe.md`. This file covers the **role-family deltas** for backend and fullstack positions only.

## When to Apply

Fire this mode when ALL hold:
- Role family is backend, fullstack, REST/GraphQL API, or microservices (not infra-primary, not ML-primary)
- JD shows EU location signals: EU/EEA/UK city, EUR/GBP/PLN/CHF/SEK/NOK/DKK salary, justjoin.it/nofluffjobs/otta.com portal, or GDPR/EU data residency references

If the role is ML/AI-primary, use `modes/eu-ml.md`. If DevOps/Platform/SRE-primary, use `modes/eu-devops.md`.

## Role Classification

| Dimension | Common EU backend signals |
|-----------|--------------------------|
| Stack | Python (Django, FastAPI, Flask), Node.js (Express, NestJS), Java (Spring Boot), Go, PHP (Laravel, Symfony), Ruby (Rails) |
| Domain | Fintech, e-commerce, SaaS, B2B platforms, data-heavy APIs, health tech |
| Seniority markers | Mid/Senior/Staff/Lead; explicit years of experience (EU JDs are often direct on this) |
| Language | English B2 minimum at international companies; German/French/Polish for local-market companies |
| Equity | Rare outside UK/Nordic startups and late-stage scale-ups; absent at most EU corporates and SMBs |

## EU-Specific Hard Filters

Run BEFORE Block B. A blocker here makes the A-G evaluation academic.

| Filter | What to check | Blocker if... |
|--------|---------------|---------------|
| Language requirement | "English B2/C1 required" or native German/French/Polish required | Candidate doesn't meet the stated threshold |
| GDPR/data privacy | "GDPR compliance", "DPA", "privacy by design" listed as hard requirement | Candidate has zero EU data-handling exposure |
| Work authorization | "EU work permit required", "no sponsorship", "right to work in EU/UK" | Candidate needs sponsorship that is not offered |
| Location/hybrid | Specific days in office, city-bound, relocation required without support | Conflicts with candidate's location policy from `config/profile.yml` |

## EU Market Notes (Backend-Specific)

These supplement the country table in `eu-swe.md`. Check that file for immigration, permit thresholds, and legal facts.

| Signal | EU backend reality |
|--------|--------------------|
| Salary transparency | Increasing in EU (France, Austria, some German states require ranges by law); absence is not a red flag in Poland/CEE — standard there |
| Equity | Assume none unless explicitly offered; signing bonus is the EU alternative to negotiate |
| Notice period | 1–3 months standard; state it when application forms ask for "earliest start date" |
| Probation period | 3–6 months standard; ask during offer stage, not application |
| GDPR as differentiator | Any EU data pipeline or user-consent handling experience is worth surfacing in Block E even when not a hard req |
| B2 English | If listed as "required" not "preferred", treat as a hard filter — check against candidate's self-assessed level |
| Remote policy | EU JDs increasingly state work model explicitly; complete absence after 2025 is a mild red flag worth flagging |
| PLN/CEE compensation | Polish and CEE salaries often listed as B2B (invoice) monthly or annual gross; confirm which in Block D |

## Scoring Adjustments

Additive adjustments applied after the standard A–G pass. These feed into existing blocks — they do not create a new block.

| Signal | Maps to | Adjustment |
|--------|---------|------------|
| Salary range shown | Block D — Comp | Higher confidence in comp data; note explicitly |
| Visa/relocation support mentioned | Block D — Comp | Reduces candidate's financial risk; note as positive |
| Remote policy clearly stated | Block A — Role Summary (Cultural signals) | Transparency signal; note as positive |
| English proficiency required and candidate clearly meets it | Block B — Match | Neutral (expected baseline at EU international companies) |
| English proficiency required, candidate's level unclear | Block B — Red flags | Soft flag; ask user to confirm before applying |
| GDPR/privacy as hard req, absent from CV | Block B — Gaps | Escalate to Block C mitigation (cover letter mention, quick GDPR cert) |
| No equity mentioned | Block D — Comp | Note as EU norm; do not penalize score |
| B2B/contract framing in JD (common in Poland) | Block D — Comp | Note gross vs. net, ask user to confirm tax model |

## Calibration Output

Append to the evaluation report when eu-backend fires:

```markdown
## EU Backend Calibration: {Company} — {Role}

**Market:** {country/city}
**Stack family:** {Python / Node.js / Java / Go / other}
**EU hard filters:** {pass / risk / blocker for each of the 4 filters above}

### CV Adjustments
- {GDPR/data privacy experience to surface, or flag as gap with mitigation}
- {Stack keyword alignment for EU ATS: use exact framework names, not "Python backend"}
- {B2 English: confirm level explicitly in cover letter if JD marks it required}

### Compensation Context
- {Salary range shown? EUR/GBP/PLN equivalent of candidate's target from profile.yml}
- {Equity: absent/present — note signing bonus as EU alternative if absent}
- {Notice period to state in form answers: X months}
- {B2B vs. employment: note if relevant}

### Facts To Verify
- {Work authorization check per eu-swe.md country table}
- {Language requirement level vs. candidate's self-assessment}
```

## Rules

- Do not invent language levels, permit statuses, or comp data.
- Do not add notice period or location details to the CV — form answers only.
- Defer to `eu-swe.md` for work-authorization and legal thresholds.
- If this fires during a pipeline run (not user-initiated), note the calibration in the report.
