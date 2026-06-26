# Mode: eu-ml — EU ML / AI / Data Application Calibration

Use when targeting ML engineer, data scientist, AI researcher, data engineer, or MLOps roles at EU/EEA/UK companies. Layers on top of the standard A–G evaluation.

The existing AI/ML archetypes in `_shared.md` (LLMOps, Agentic, AI Platform, etc.) still classify the role first. EU calibration is a layer on top — it does not replace archetype detection. Classify archetype, then apply this file for EU-specific adjustments.

For work-authorization, language, and country-specific legal facts, defer to `modes/regional/eu-swe.md`.

## When to Apply

Fire when ALL hold:
- Role family is ML engineer, data scientist, AI researcher, data engineer, MLOps, AI platform, or NLP engineer
- JD shows EU location signals: EU/EEA/UK city, EUR/GBP/PLN salary, EU AI Act/GDPR references, EU-based portal (justjoin.it, nofluffjobs, otta.com)

## Role Classification

| Dimension | Common EU ML/AI signals |
|-----------|------------------------|
| ML stack | PyTorch, TensorFlow, scikit-learn, HuggingFace, LangChain, vLLM, Sentence Transformers |
| MLOps/data | MLflow, Kubeflow, Airflow, Prefect, dbt, Spark, BigQuery, Snowflake, DuckDB |
| Serving | FastAPI + model serving, BentoML, Triton, Seldon, KServe |
| Research signals | "Publications preferred", "PhD", applied research, university ties, technical blog |
| Production signals | "Deployed models", "inference serving", "A/B testing", "latency SLAs", "model monitoring" |
| EU AI Act | "High-risk AI", "AI governance", "explainability", "bias auditing", "model registry", "conformity assessment" |
| GDPR/privacy | "Privacy-preserving ML", "data minimization", "consent pipeline", "EU data residency", "federated learning" |

## EU AI Act — Differentiator for Senior Roles

The EU AI Act (in force from August 2024, with phased enforcement) creates a genuine differentiator for candidates who have shipped AI in regulated contexts. Surface proactively — even when the JD does not mention it — if the company is in a high-risk sector.

| EU AI Act signal in JD | CV alignment to look for |
|------------------------|--------------------------|
| High-risk sector (healthcare, HR/hiring, credit scoring, law enforcement) | Compliance-aware deployment, risk classification, human-in-the-loop design, audit trails |
| "Explainability" / "XAI" / "model transparency" | SHAP, LIME, Captum, model cards, interpretable model choices |
| "AI governance" / "model registry" / "approval workflow" | MLflow Model Registry, staged promotion, change-control process |
| "Bias auditing" / "fairness" / "demographic parity" | Fairness metrics, disparate impact analysis, sensitive-attribute testing |
| "Data residency EU only" / "Schrems II" | EU-region cloud deployments, data localization experience |
| General compliance mention without specifics | Note as signal; do not overstate candidate's depth |

**If the candidate has ANY EU AI Act alignment:** surface in Block E (Customization Plan) with exact CV language.  
**If the role is high-risk sector AND candidate has no AI Act exposure:** flag as a gap in Block B with a mitigation plan (e.g., "Brief EU AI Act overview in cover letter; reference privacy-aware design in past project").

## EU-Specific Hard Filters

| Filter | What to check | Blocker if... |
|--------|---------------|---------------|
| Language requirement | English B2+? German/French for customer-facing or research roles? | Candidate below stated threshold |
| Work authorization | Sponsorship offered? | Candidate needs it and it is not offered |
| Degree requirement | "PhD required" or "MSc/PhD preferred" — EU research labs and some enterprises are stricter on this than US companies | Hard req and candidate has BSc only, with no compensating publication record |
| Data residency | "Must process data in EU only" | Conflicts with candidate's existing toolchain if cloud-locked outside EU |

## Scoring Adjustments

Adjustments applied after the standard A–G pass, feeding into existing blocks.

| Signal | Maps to | Adjustment |
|--------|---------|------------|
| EU AI Act mention + candidate has governance/compliance experience | Block B — Match | Strong positive signal; highlight in Block E |
| EU AI Act hard requirement, candidate has no governance exposure | Block B — Gaps | Gap; propose mitigation (cover letter framing, quick read of the Act) |
| GDPR/privacy ML as hard req | Block B — Match or Gaps | Match if in CV; gap with mitigation if absent |
| "PhD preferred" (soft), candidate has strong production deployment record | Block C — Level strategy | Plan: lead with shipped-model record, not academic pedigree |
| "PhD required" (hard), candidate has BSc | Block B — Gaps | Hard filter; flag explicitly |
| Salary range shown | Block D — Comp | Higher confidence; note explicitly |
| Visa/relocation support mentioned | Block D — Comp | Reduces risk; note as positive |
| Remote policy stated | Block A — Role Summary | Transparency positive |
| Equity absent (EU norm outside UK/Nordic) | Block D — Comp | Note as EU norm; do not penalize |
| B2B/contract framing (Poland/CEE) | Block D — Comp | Note gross vs. net; ask user to confirm |

## Calibration Output

Append to the evaluation report when eu-ml fires:

```markdown
## EU ML Calibration: {Company} — {Role}

**Market:** {country/city}
**ML domain:** {research / applied / MLOps / data engineering / AI governance}
**AI/ML archetype (from _shared.md):** {LLMOps / Agentic / Platform / other}
**EU AI Act relevance:** {high-risk sector: yes/no | governance signals found: {list or none}}
**EU hard filters:** {pass / risk / blocker for each filter}

### CV Adjustments
- {EU AI Act / governance experience to surface, or gap with mitigation plan}
- {GDPR-compliant ML pipeline experience if relevant to JD}
- {Stack alignment: exact framework names for EU ATS — PyTorch not "deep learning framework"}

### Compensation Context
- {Salary range shown? EUR/GBP equivalent of candidate's target from profile.yml}
- {Equity: absent/present — signing bonus as EU alternative}
- {B2B vs. employment if relevant (Poland/CEE)}

### Facts To Verify
- {Work authorization per eu-swe.md country table}
- {Degree requirement: hard vs. preferred — check JD wording precisely}
```

## Rules

- Never invent EU AI Act compliance experience. Surface only what exists in `cv.md` / `article-digest.md`.
- Run `_shared.md` archetype detection first; this file is a market calibration layer, not an archetype replacement.
- For country-specific legal and permit facts, defer to `eu-swe.md`.
- If the JD is in a high-risk AI Act sector but the JD does not mention the Act, still flag it — the candidate's familiarity is a differentiator even when the company has not yet caught up.
