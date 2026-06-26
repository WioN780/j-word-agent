# Mode: eu-devops — EU DevOps / Platform / SRE Application Calibration

Use when targeting DevOps engineer, platform engineer, SRE, infrastructure engineer, or cloud engineer roles at EU/EEA/UK companies. Layers on top of the standard A–G evaluation.

For work-authorization, language, and country-specific legal facts, defer to `modes/regional/eu-swe.md`.

## When to Apply

Fire when ALL hold:
- Role family is DevOps, platform engineering, SRE, infrastructure, cloud, or site reliability
- JD shows EU location signals: EU/EEA/UK city, EUR/GBP/PLN salary, EU portal, or EU data sovereignty/compliance references

If the role is backend-primary with some infra duties, use `eu-backend.md` instead.

## Role Classification

| Dimension | Common EU DevOps/Platform signals |
|-----------|----------------------------------|
| Orchestration | Kubernetes (K8s), Helm, Kustomize, Argo CD, Flux CD, Crossplane |
| IaC | Terraform, Pulumi, Ansible, CloudFormation, CDK, Bicep |
| Cloud | AWS, GCP, Azure — EU-region preference common; OVHcloud, Hetzner, Scaleway in CEE/DACH |
| CI/CD | GitLab CI (dominant in EU), GitHub Actions, Jenkins, CircleCI, Tekton |
| Observability | Prometheus, Grafana, Loki, Tempo, Jaeger, OpenTelemetry, Datadog, New Relic, Dynatrace |
| Security | HashiCorp Vault, OPA/Gatekeeper, Falco, SOPS, Trivy — EU compliance context common |
| On-call | PagerDuty, OpsGenie — EU labor law constrains on-call models differently than US |
| EU compliance | Schrems II, EU data residency, ISO 27001/SOC2 (common for EU SaaS), DORA (financial services) |

## EU-Specific Hard Filters

| Filter | What to check | Blocker if... |
|--------|---------------|---------------|
| Language requirement | English B2+? German/French/Dutch for local infra or vendor-facing teams? | Candidate below stated threshold |
| Work authorization | Sponsorship offered? | Candidate needs it and it is not offered |
| Security clearance | "NATO clearance", "national security", "Baseline Personnel Security Standard (BPSS, UK)", "Geheimschutzbetreuung (DE)" | Candidate ineligible |
| On-call model | On-call hours, frequency, compensation — EU labor law (especially DE/FR) limits unpaid on-call | Candidate's jurisdiction has an incompatible legal on-call model |
| Cloud certifications | "AWS/GCP/Azure certified required" — EU enterprises and public sector check this more strictly than US startups | Hard certification req the candidate does not hold |

## EU Market Notes (DevOps-Specific)

These supplement the country table in `eu-swe.md`.

| Signal | EU DevOps reality |
|--------|--------------------|
| GitLab CI dominance | Dominant in European companies (Germany, Poland, Netherlands, France) vs. GitHub Actions in US-founded companies. Surface GitLab CI experience explicitly in Block E. If candidate only has GitHub Actions, note as adjacent and transferable. |
| EU-region cloud preference | Many EU companies require workloads in EU-region AWS/GCP/Azure or EU-native providers (OVHcloud, Hetzner) for GDPR/Schrems II compliance. Any EU-region cloud deployment experience is worth surfacing. |
| On-call compensation | German labor law (ArbZG), French labor law, and others mandate on-call compensation or time-off equivalents. Ask about on-call structure during the interview, not the application. |
| EU data sovereignty | "Schrems II compliance", "data residency EU", "Privacy Shield replacement", "SCC/SCCs" — infrastructure-level concerns. Surface if candidate has shipped EU-compliant cross-border data pipelines. |
| Salary transparency | CEE markets (Poland, Czech Republic, Romania) often omit salary ranges; Western EU increasingly required. Absence in DE/FR after 2025 is a mild red flag. |
| Certifications | CKA, CKAD, CKS, AWS SAA/SAP, GCP-ACE, Azure Solutions Architect — more valued in EU enterprise and public-sector procurement than at US-founded startups. Lead with certs when targeting enterprise clients. |
| DORA Act (financial services) | EU Digital Operational Resilience Act (DORA, effective Jan 2025) requires strict ICT resilience standards for financial entities. Any fintech/banking infrastructure experience maps directly. |
| B2B/contract framing | Poland and CEE frequently post DevOps roles as B2B contracts. Confirm tax model with candidate before proceeding. |

## Scoring Adjustments

Applied after the standard A–G pass, feeding into existing blocks.

| Signal | Maps to | Adjustment |
|--------|---------|------------|
| GitLab CI required and candidate has it | Block B — Match | Positive signal; surface explicitly in Block E |
| GitLab CI required, candidate has GitHub Actions only | Block B — Gaps | Adjacent experience; note in Block E as "transferable, short ramp" |
| EU data sovereignty/Schrems II mentioned + candidate has EU cloud ops | Block B — Match | Surface in Block E; strong differentiator for regulated sectors |
| On-call structure unclear or unpaid model that conflicts with EU labor law | Block A — Cultural signals | Flag for interview question; do not penalize score |
| Security clearance required | Block B — Hard filters | Blocker if candidate ineligible; state clearly in hard-filter table |
| DORA-relevant role (EU financial services infra) + candidate has fintech infra experience | Block B — Match | Surface explicitly |
| Certification required and candidate holds it | Block B — Match | Note explicitly |
| Certification required and candidate lacks it | Block B — Gaps | Flag; propose mitigation (cloud cert timeline) |
| Salary range shown | Block D — Comp | Higher confidence; note |
| Visa/relocation support mentioned | Block D — Comp | Reduces risk; note as positive |
| Remote policy stated | Block A — Role Summary | Transparency positive |
| B2B/contract framing (Poland/CEE) | Block D — Comp | Note gross vs. net; confirm tax model |
| OVHcloud/Hetzner/EU-native cloud mentioned | Block B — Match or Gaps | Match if candidate has it; gap if not (shorter ramp than AWS/GCP — note accordingly) |

## Calibration Output

Append to the evaluation report when eu-devops fires:

```markdown
## EU DevOps Calibration: {Company} — {Role}

**Market:** {country/city}
**Platform focus:** {Kubernetes / IaC / CI-CD / observability / cloud / SRE / security}
**EU hard filters:** {pass / risk / blocker for each filter}

### CV Adjustments
- {GitLab CI: surface explicitly if present, or note GitHub Actions as adjacent}
- {EU data sovereignty / Schrems II experience if relevant to JD}
- {Certifications: lead with CKA/AWS/GCP certs for enterprise EU roles}
- {DORA exposure if fintech/banking infra}

### Compensation Context
- {Salary range shown? EUR/GBP equivalent of candidate's target from profile.yml}
- {On-call compensation model if mentioned in JD}
- {B2B vs. employment: note if relevant (Poland/CEE)}

### Facts To Verify
- {Work authorization per eu-swe.md country table}
- {Security clearance eligibility if required}
- {On-call legal structure in the role's country — flag for interview Q}
```

## Rules

- Do not invent certifications, clearance levels, or EU-compliance experience.
- On-call legal constraints vary significantly by country — flag for verification, do not advise definitively.
- Defer to `eu-swe.md` for country-specific permit and immigration facts.
- If this fires during a pipeline run, note the calibration in the report.
