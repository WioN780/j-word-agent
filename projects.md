# Project Pool

<!-- ============================================================
     USER LAYER — your projects live here, never auto-updated.
     Add, remove, or edit any entry freely.
     
     SELECTION RULE (for agents): when generating a CV, read all
     entries below and select the 2-3 whose stack_tags and keywords
     best match the job description. Prioritise exact technical
     terms used in the JD over general domain alignment.
     Drop the weakest match when selecting 2 out of 3+.
     ============================================================ -->

---

## FastAPI Gateway

**Description:** Production-grade REST API gateway with async background task processing.

**Stack tags:** Python, FastAPI, PostgreSQL, Docker, Redis, Celery, SQLAlchemy, Alembic, pytest

**Domain tags:** backend, API, data-engineering, infrastructure

**Impact:** Handles 5 000 req/s with p99 < 80 ms; Dockerised with compose for one-command local setup; zero-downtime migrations via Alembic. Powers three downstream microservices in staging.

**Keywords:** FastAPI, async API, PostgreSQL, Docker, REST, background jobs, database migrations, microservices, Python backend, SQLAlchemy

**Link:** https://github.com/example/fastapi-gateway

---

## ShopFlow Dashboard

**Description:** React SPA with real-time inventory tracking and data-visualisation components.

**Stack tags:** TypeScript, React, Next.js, TailwindCSS, Recharts, Supabase, Vercel

**Domain tags:** frontend, web, e-commerce, real-time

**Impact:** Reduced average page load from 3.1 s to 0.8 s (Lighthouse 94). Adopted by two small retailers with 200+ daily active users. Zero A/B-test tooling cost — built custom variant tracking with Supabase Realtime.

**Keywords:** React, Next.js, TypeScript, TailwindCSS, real-time, data visualisation, frontend, SPA, Supabase, Vercel

**Link:** https://github.com/example/shopflow-dashboard

---

## SensorMesh

**Description:** Lightweight IoT telemetry pipeline collecting sensor data from ESP32 nodes into InfluxDB for Grafana dashboards.

**Stack tags:** C++, MicroPython, MQTT, InfluxDB, Grafana, Raspberry Pi, ESP32, Docker

**Domain tags:** IoT, embedded, telemetry, data-pipeline, infrastructure

**Impact:** Monitors 40 sensors across a 1 200 m² greenhouse; 99.8% uptime over 6 months; alert latency under 2 s. Reduced manual inspection time by ~4 h/week.

**Keywords:** IoT, MQTT, InfluxDB, Grafana, telemetry, embedded, ESP32, MicroPython, sensor, data pipeline

**Link:** https://github.com/example/sensormesh

---

## RAG Evaluation Framework

**Description:** Retrieval-augmented generation pipeline with automated evaluation harness for measuring retrieval quality, answer faithfulness, and latency under load.

**Stack tags:** Python, LangChain, FAISS, OpenAI, MLflow, FastAPI, PostgreSQL, Docker

**Domain tags:** ML, AI, LLMOps, evaluation, retrieval, data-pipeline

**Impact:** Tracks 12 evaluation metrics (RAGAS faithfulness, context recall, answer relevancy) per experiment run. MLflow dashboard shows regression within 30 s of a bad deploy. Reduced mean time to catch quality regressions from 2 days (manual review) to 4 minutes. Serves 200+ nightly evaluation runs.

**Keywords:** RAG, LangChain, FAISS, vector search, LLM evaluation, MLflow, RAGAS, faithfulness, OpenAI, Python, retrieval, LLMOps, prompt engineering

**Link:** https://github.com/example/rag-eval-framework

---

## K8s Monitoring Stack

**Description:** Opinionated Kubernetes observability stack deployed via Helm and Terraform, with alerting, dashboards, and runbook automation.

**Stack tags:** Kubernetes, Helm, Terraform, Prometheus, Grafana, Loki, AlertManager, GitHub Actions, AWS EKS

**Domain tags:** DevOps, platform, SRE, infrastructure, observability, cloud

**Impact:** Unified 6 siloed per-team dashboards into a single Grafana multi-tenant workspace. MTTR dropped from 47 min to 9 min after adding alert-to-runbook links. Stack deployed to 3 EKS clusters via a single `terraform apply`. On-call escalations reduced 60% in 3 months.

**Keywords:** Kubernetes, Helm, Terraform, Prometheus, Grafana, Loki, AlertManager, EKS, SRE, observability, infrastructure as code, GitOps, platform engineering

**Link:** https://github.com/example/k8s-monitoring-stack

---

## Analytics dbt Pipeline

**Description:** Data transformation layer built with dbt on top of a Snowflake warehouse, with Airflow orchestration and data quality tests on every model.

**Stack tags:** Python, dbt, Snowflake, Apache Airflow, Great Expectations, SQL, Docker, GitHub Actions

**Domain tags:** data-engineering, analytics, data-pipeline, ETL, warehouse

**Impact:** Replaced 14 fragile hand-written SQL scripts with 38 versioned, tested dbt models. Data freshness SLA improved from 6 h to 45 min. 100% of models have at least one Great Expectations test — data quality failures now block DAG progression automatically. Used by 4 business analysts daily.

**Keywords:** dbt, Snowflake, Airflow, data pipeline, ETL, data quality, Great Expectations, SQL, analytics engineering, Python, data warehouse, orchestration

**Link:** https://github.com/example/analytics-dbt-pipeline
