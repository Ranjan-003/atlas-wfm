# Atlas WFM — Production Architecture

This document describes how the static SPA in this repository maps to a production-grade, multi-tenant, enterprise-scale Workforce Intelligence Platform. The code in `/src` is organized to mirror the production service boundaries exactly — each engine is one microservice in production.

---

## 1. The Six Layers

A production Atlas deployment is six layers, top to bottom:

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 6 — Experience Layer  (Web SPA, Mobile, Embedded)       │
│            React/Next.js • Voice UI • Slack/Teams embedded      │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5 — Decision Intelligence  (AI Copilot + Recommender)   │
│            Intent router • Grounded RAG • Recommendation API   │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4 — Optimization Layer  (Solvers + Simulation)          │
│            MILP/CP-SAT solver pool • Monte Carlo runner         │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3 — Module Services  (the 5 core engines)               │
│            Forecasting • Capacity • Scheduling • Intraday •    │
│            Deflection                                          │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2 — Data Platform  (Ingestion + Feature Store + DWH)    │
│            Kafka • Snowflake • Feature store • dbt models      │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1 — Connectors  (ACD, CRM, HRIS, IDP, Notification)     │
│            Genesys • NICE • Amazon Connect • Salesforce •      │
│            Workday • Okta • Slack/Teams                        │
└─────────────────────────────────────────────────────────────────┘
```

The static SPA in this repository implements Layers 3, 4 (heuristically), 5, and 6. Layers 1 and 2 are replaced by the in-browser seeded data generator (`src/data/seed.js`) and CSV importer (`src/data/csv.js`).

---

## 2. Service-by-service mapping

Every file in `src/engines/` becomes a service in production. The function signatures stay; only the transport changes.

| In-browser module | Production service | Tech | Why this split |
|---|---|---|---|
| `src/engines/forecasting.js` | `forecasting-svc` | Python + FastAPI; PyTorch / statsmodels / Prophet; MLflow for model registry | ML model lifecycle is fundamentally different cadence (re-train weekly) than read traffic (every page load) — must isolate. |
| `src/engines/capacity.js` | `capacity-svc` | Python + FastAPI; SciPy for Erlang; pandas for FTE rollups | Pure compute, no ML. Can scale horizontally behind a load balancer. |
| `src/engines/scheduling.js` | `scheduling-svc` | Python + CP-SAT (Google OR-Tools) or Gurobi | Solver workloads are bursty and CPU-bound; need their own autoscaling pool with longer timeouts. |
| `src/engines/intraday.js` | `intraday-svc` | Go or Rust for hot-path real-time; Redis pub/sub for fan-out | Microsecond-sensitive event loop processing 10k+ ACD events/sec across tenants. |
| `src/engines/deflection.js` | `deflection-svc` | Python + FastAPI; reuses Capacity for propagation | Modeling + propagation; sits between Forecasting and Capacity. |
| `src/copilot/copilot.js` | `copilot-svc` | Python + FastAPI; intent classifier + retrieval over Snowflake | Intent layer stays deterministic; only the *retrieval* uses an LLM, never the *answer composition*. |
| `src/data/csv.js` | `ingest-svc` + dbt | Python (Polars) for parse + classify; dbt for normalization | Ingestion and modelling are distinct concerns — ingest is event-driven, modelling is batch. |
| `src/data/seed.js` | `dwh-snapshot-svc` | Snowflake + dbt | Production reads from the warehouse, not a generator. |

---

## 3. Cross-module data contracts

Every interaction between modules goes through a versioned contract. These are the four primary contracts:

### 3.1  `forecast.v1`
The output of `forecasting-svc`, consumed by `capacity-svc` and `intraday-svc`.

| Field | Type | Notes |
|---|---|---|
| `queue_id` | string | matches `queues.id` |
| `interval_start` | timestamp | 30-min granularity at minimum |
| `volume_mean` | float | point forecast |
| `volume_p05` | float | lower bound |
| `volume_p95` | float | upper bound |
| `aht_mean` | float | seconds |
| `model_id` | string | which model produced this row |
| `accuracy_wape` | float | WAPE on validation |
| `anomaly_flag` | bool | true if input series contained recent anomaly |
| `forecast_run_id` | uuid | for reproducibility |

### 3.2  `requirement.v1`
Output of `capacity-svc`, consumed by `scheduling-svc`.

| Field | Type | Notes |
|---|---|---|
| `queue_id` | string | |
| `interval_start` | timestamp | |
| `required_net_agents` | float | from Erlang or productivity model |
| `required_gross_fte` | float | with shrinkage applied |
| `target_sl` | float | the SL this is computed against |
| `method` | enum | `erlang_c`, `erlang_a`, `chat_concurrency`, `productivity` |

### 3.3  `schedule.v1`
Output of `scheduling-svc`, consumed by `intraday-svc` and the agent app.

| Field | Type | Notes |
|---|---|---|
| `agent_id` | string | |
| `date` | date | |
| `shift_id` | string | from shift catalog |
| `shift_start` | timestamp | |
| `shift_end` | timestamp | |
| `breaks` | array<{start,end}> | scheduled non-productive time |
| `skill_assignments` | array<string> | primary + secondary skills |
| `status` | enum | `draft`, `published`, `swapped`, `cancelled` |

### 3.4  `intraday_event.v1`
Stream from connectors via Kafka, consumed by `intraday-svc`.

| Field | Type | Notes |
|---|---|---|
| `event_type` | enum | `call_offered`, `call_answered`, `call_abandoned`, `state_change`, `aht_actual` |
| `queue_id` | string | |
| `agent_id` | string | nullable |
| `timestamp` | timestamp | wall clock |
| `payload` | json | event-specific |

---

## 4. Database schema (core tables)

```sql
-- Reference dimensions
CREATE TABLE tenants (
  tenant_id      VARCHAR PRIMARY KEY,
  name           VARCHAR NOT NULL,
  industry       VARCHAR,
  tier           VARCHAR,
  created_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sites (
  site_id        VARCHAR PRIMARY KEY,
  tenant_id      VARCHAR REFERENCES tenants(tenant_id),
  name           VARCHAR NOT NULL,
  timezone       VARCHAR NOT NULL,
  country        CHAR(2) NOT NULL
);

CREATE TABLE queues (
  queue_id       VARCHAR PRIMARY KEY,
  tenant_id      VARCHAR REFERENCES tenants(tenant_id),
  name           VARCHAR NOT NULL,
  channel        VARCHAR NOT NULL,
  sl_target      FLOAT NOT NULL,
  sl_target_sec  INT NOT NULL,
  concurrency    FLOAT,         -- chat / async
  aht_default    FLOAT,
  shrinkage      FLOAT,
  occupancy_target FLOAT,
  active         BOOL DEFAULT TRUE,
  created_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE agents (
  agent_id       VARCHAR PRIMARY KEY,
  tenant_id      VARCHAR REFERENCES tenants(tenant_id),
  site_id        VARCHAR REFERENCES sites(site_id),
  full_name      VARCHAR,
  hire_date      DATE,
  termination_date DATE,
  primary_skill  VARCHAR,
  secondary_skills VARCHAR[],
  weekly_hours   FLOAT DEFAULT 40,
  status         VARCHAR
);

-- Time series fact tables (partitioned by date)
CREATE TABLE volumes_interval (
  tenant_id      VARCHAR NOT NULL,
  queue_id       VARCHAR NOT NULL,
  interval_start TIMESTAMP NOT NULL,
  offered        INT,
  handled        INT,
  abandoned      INT,
  aht_sec        FLOAT,
  sl_pct         FLOAT,
  PRIMARY KEY (tenant_id, queue_id, interval_start)
) PARTITION BY RANGE (interval_start);

CREATE TABLE forecasts (
  forecast_run_id  UUID,
  tenant_id        VARCHAR NOT NULL,
  queue_id         VARCHAR NOT NULL,
  interval_start   TIMESTAMP NOT NULL,
  volume_mean      FLOAT,
  volume_p05       FLOAT,
  volume_p95       FLOAT,
  aht_mean         FLOAT,
  model_id         VARCHAR,
  accuracy_wape    FLOAT,
  created_at       TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (forecast_run_id, queue_id, interval_start)
);

CREATE TABLE schedules (
  schedule_id    UUID PRIMARY KEY,
  agent_id       VARCHAR REFERENCES agents(agent_id),
  date           DATE NOT NULL,
  shift_id       VARCHAR NOT NULL,
  shift_start    TIMESTAMP NOT NULL,
  shift_end      TIMESTAMP NOT NULL,
  breaks         JSONB,
  skill_assignments VARCHAR[],
  status         VARCHAR,
  version        INT DEFAULT 1,
  published_at   TIMESTAMP,
  published_by   VARCHAR
);

CREATE TABLE intraday_events (
  event_id       UUID PRIMARY KEY,
  tenant_id      VARCHAR NOT NULL,
  queue_id       VARCHAR,
  agent_id       VARCHAR,
  event_type     VARCHAR NOT NULL,
  occurred_at    TIMESTAMP NOT NULL,
  payload        JSONB,
  ingested_at    TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (occurred_at);

CREATE TABLE copilot_log (
  log_id         UUID PRIMARY KEY,
  tenant_id      VARCHAR,
  user_id        VARCHAR,
  question       TEXT,
  intent         VARCHAR,
  response       TEXT,
  sources        JSONB,
  latency_ms     INT,
  created_at     TIMESTAMP DEFAULT NOW()
);

-- RBAC
CREATE TABLE roles (role_id VARCHAR PRIMARY KEY, label VARCHAR NOT NULL);
CREATE TABLE role_permissions (role_id VARCHAR, permission VARCHAR, PRIMARY KEY (role_id, permission));
CREATE TABLE user_roles (user_id VARCHAR, tenant_id VARCHAR, role_id VARCHAR, PRIMARY KEY (user_id, tenant_id, role_id));
```

---

## 5. Tech stack (production)

| Concern | Choice | Why |
|---|---|---|
| API framework | Python + FastAPI | Excellent type safety; first-class async; large ML ecosystem |
| Real-time hot path | Go (or Rust for the highest-volume tenants) | Predictable latency under load; no GC stalls |
| ML / forecasting | statsmodels, Prophet, scikit-learn, PyTorch (for N-BEATS / Transformer variants) | Mix of classical + deep learning to cover all queue archetypes |
| Solver | Google OR-Tools (CP-SAT) primary; Gurobi for largest enterprise tenants | CP-SAT is free and excellent up to ~1000 agents per problem; Gurobi for global rosters |
| Warehouse | Snowflake | Multi-tenant isolation, time-travel, cheap historical compute |
| Streaming | Kafka (Confluent Cloud) | The contact-center ACD world produces high-volume event streams |
| Cache / pubsub | Redis | Sub-ms intraday state |
| OLTP | PostgreSQL | Tenant config, RBAC, schedules-in-progress |
| Feature store | Feast or Tecton | Reused features across forecasting + intraday + scenarios |
| ML registry | MLflow | Model versioning + deployment trails |
| Front-end | React/Next.js (Vercel) | Same component model; this SPA's UI primitives map 1:1 |
| Auth | Okta / Azure AD via OIDC | Enterprise SSO is non-negotiable |
| Observability | Datadog or Grafana Cloud + Honeycomb | Metrics, traces, logs |
| Orchestrator | Kubernetes (EKS) | Autoscaling of solver pool and ML training jobs |
| CI/CD | GitHub Actions + ArgoCD | GitOps for production |

---

## 6. The AI Copilot — grounded by design

The copilot in `src/copilot/copilot.js` is deliberately deterministic. The pattern transfers to production as:

```
                ┌────────────────────────────────────┐
   User Q ─────▶│  Intent classifier (BERT or rules) │
                └────────────────────────────────────┘
                              │
                              ▼
                ┌────────────────────────────────────┐
                │  Entity extractor (queue, %, etc.) │
                └────────────────────────────────────┘
                              │
                              ▼
                ┌────────────────────────────────────┐
                │  Engine router — calls deterministic│
                │  service(s); only the engines compute│
                └────────────────────────────────────┘
                              │
                              ▼
                ┌────────────────────────────────────┐
                │  Response composer — templated text │
                │  with engine outputs interpolated   │
                │  (LLM may polish, never invent)     │
                └────────────────────────────────────┘
```

The key invariant: numbers in the response come only from engine outputs. If the copilot would have to "guess," it returns the not-sure-yet fallback. This is what makes it safe to put in front of operations managers making real staffing calls.

---

## 7. Multi-tenancy model

Tenant isolation is at three layers:

1. **Data**: every fact table has `tenant_id` as the partition key. Snowflake row-level security policies enforce isolation regardless of query.
2. **Compute**: largest tenants get dedicated solver pools (k8s node taints); smaller tenants share. Forecasting model registry is keyed by `(tenant_id, queue_id, model_id)`.
3. **API**: every request carries a tenant JWT claim verified at the API gateway; services receive a `TenantContext` they cannot escape.

---

## 8. Scaling envelope

The design holds at these target scales, validated by similar systems:

| Dimension | Target |
|---|---|
| Tenants per cluster | 100+ |
| Agents per tenant | 50,000 |
| Queues per tenant | 500 |
| Intraday events/sec ingested | 50,000 |
| p95 forecast latency (per queue) | < 1.5s |
| p95 schedule generation (1000-agent week) | < 90s |
| Copilot p95 response | < 600ms |

---

## 9. Non-goals (intentional limits)

- **Atlas does not provide ACD/IVR functionality**. It plugs into yours.
- **Atlas does not handle payroll**. It produces hours-worked artifacts that flow to your payroll system (Workday, ADP).
- **Atlas does not handle hiring / recruiting**. It outputs hire requirements; your ATS handles the rest.
- **Atlas is not a quality-monitoring or speech-analytics platform**. Those are separate, mature categories.

Staying disciplined about these boundaries is what makes Atlas integrable into existing enterprise stacks rather than asking customers to rip everything out.
