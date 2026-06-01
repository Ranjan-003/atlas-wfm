# Atlas WFM

**Enterprise Workforce Intelligence Platform** — Forecasting, Capacity Planning, Scheduling, Intraday/RTA, AI Deflection, and a grounded AI Copilot, packaged as a multi-file static SPA.

This is a working, multi-page application with real production-grade math (Erlang C/A, Holt-Winters, ensemble forecast selection, MAD-based anomaly detection, interval-level coverage fitting), built so it runs locally with zero dependencies but is architected the way a production microservice WFM platform would be split.

---

## Running it

**Option A — Just open it locally (no server):**
```
Double-click index.html
```
Most modern browsers will run it directly from the filesystem because we use classic `<script>` tags rather than ES modules.

**Option B — Static server (recommended):**
```bash
cd atlas-wfm
python3 -m http.server 8000
# then open http://localhost:8000
```

**Option C — Deploy as a static site** to S3, Vercel, Netlify, GitHub Pages, or behind nginx. Nothing else is required — no build step, no Node runtime, no package manager.

---

## What you get in this build

| Area | Status | Notes |
|---|---|---|
| Forecasting engine | **Working** | Moving Avg, Holt-Winters, Naive Seasonal, Croston, weighted Ensemble + walk-forward model selection |
| Capacity planner | **Working** | Erlang C, Erlang A, chat concurrency, email productivity, FTE with shrinkage/occupancy, hiring plan generator |
| Scheduling | **Working** | Shift catalog, greedy fitter, weekly roster, multi-skill sim, US/UK/EU/IN/PH compliance rules |
| Intraday / RTA | **Working** | Variance, SL pacing projection, tiered intervention recommender, adherence scoring, live simulator |
| AI Deflection | **Working** | Tier-based deflection, residual AHT shift modeling, capacity impact propagation |
| What-if Scenarios | **Working** | Sliders for vol / AHT / shrinkage / attrition / deflection, propagation through Erlang + cost |
| AI Copilot | **Working** | Intent classifier, entity extraction, 12 grounded intents — no LLM, cannot hallucinate |
| Data Studio | **Working** | CSV upload, drag-drop, column auto-classification, quality report, smart follow-up questions |
| Analytics | **Working** | Forecast accuracy distribution, volatility ranking, channel rollup, queue detail |
| Admin | **Working** | Multi-tenant view, RBAC role/permission matrix, connector catalogue, audit trail |
| Sample dataset | **Working** | 5 tenants, 3 sites, 24 queues, 4 channels, 84 days of daily history + 14 days at 30-min intervals |

Everything in the table is real — none of it is a "Coming soon" placeholder. The math runs in your browser.

What's **deliberately scaffolded** vs production:

- **Persistence**: state lives in memory; refreshing resets uploaded data. In production this would back to a Snowflake-style warehouse.
- **Auth**: no login; admin shows what RBAC *should* look like with the roles enumerated. Production would integrate Okta/SSO via the IDP connector.
- **Real ACD integration**: the `Connectors` page lists what would plug into Genesys/NICE/Amazon Connect/Twilio. In this build, all data is synthesized by the seeded generator.
- **Persisting scenario versions and approvals**: UI surface is there; no version store wired.

---

## What it does NOT do (and why that matters)

- It does not call out to a cloud service or send any data anywhere. All compute is client-side.
- The AI Copilot does **not** use an LLM. It uses deterministic intent classification and looks up answers in the platform's own computed engine outputs. This is a feature: it cannot hallucinate. The trade-off is that it can only answer questions the rule-base understands; everything else gets a helpful "not sure how to answer that" fallback.

---

## File layout

```
atlas-wfm/
├── index.html                  ← Entry point; loads all scripts in dependency order
├── README.md                   ← This file
├── ARCHITECTURE.md             ← How the production version would be built
├── ROADMAP.md                  ← Phased build plan, 18 months
├── styles/
│   ├── tokens.css              ← Design tokens (colors, type, spacing)
│   ├── base.css                ← Reset + typography
│   ├── layout.css              ← App shell, sidebar, topbar, copilot drawer
│   └── components.css          ← Cards, KPI tiles, tables, charts, badges
└── src/
    ├── app.js                  ← Boot, router, sidebar, copilot wiring
    ├── state.js                ← Pub/sub state store
    ├── ui/
    │   ├── icons.js            ← Inline SVG icon library
    │   ├── charts.js           ← Pure SVG charts: line, bar, heatmap, gauge, donut, sparkline
    │   └── components.js       ← KPI tiles, cards, insights, modal, toast
    ├── engines/
    │   ├── forecasting.js      ← MA, Holt-Winters, Naive Seasonal, Croston, Ensemble + auto-select
    │   ├── capacity.js         ← Erlang C/A, FTE, hiring plan, risk score
    │   ├── scheduling.js       ← Shift fitter, coverage scorer, compliance rules
    │   ├── intraday.js         ← Variance, SL pacing, intervention recommender
    │   └── deflection.js       ← Tiered deflection + scenario propagation
    ├── data/
    │   ├── seed.js             ← Seeded PRNG dataset generator
    │   └── csv.js              ← CSV parser + column auto-classifier
    ├── copilot/
    │   └── copilot.js          ← Intent classification + grounded responder
    └── modules/                ← UI per route, each exports mount(rootEl, state)
        ├── dashboard.js
        ├── forecasting.js
        ├── capacity.js
        ├── scheduling.js
        ├── intraday.js
        ├── scenarios.js
        ├── deflection.js
        ├── analytics.js
        ├── data-studio.js
        └── admin.js
```

Each engine and each module is independently swappable. In production, the engines would become microservice API calls; the UI layer wouldn't change.

---

## Try this first

1. Open the app — you land on the **Dashboard**.
2. Click **Ask Copilot** (top right) and try: *"which queues are understaffed?"*, *"what if volume goes up 20%?"*, *"summary for fraud hotline"*.
3. Go to **Forecasting** → pick a queue → see actuals + forecast + CI band + auto-model-selection.
4. Go to **Intraday** → click **Live** → watch the simulation tick interval-by-interval, with the recommendation engine adjusting in real time.
5. Go to **Scenarios** → drag the sliders → watch staffing and cost recompute against Erlang C.
6. Go to **Data Studio** → click **Use sample data** → see how column auto-classification works.

---

## Design philosophy

This is built like a Bloomberg terminal — dense, monospaced numbers, hairline dividers, restrained color, amber as the singular accent. The visual goal is *informational precision*, not decoration.

The codebase deliberately avoids the things that make WFM software "AI-slop": no purple gradients, no faux animations, no nondescript modal popups. Every visual choice supports decision-making.

---

## License

Internal — see your organization's terms.
