/* =========================================================
 * Forecasting · COMPAT SHIM
 *
 * Phase 2 split the forecasting engine into 4 modules under
 *   /src/engines/forecasting/
 *     - stats.js    : math primitives
 *     - models.js   : 6 model implementations + naive baseline
 *     - selector.js : pattern analysis + walk-forward backtest + selection
 *     - engine.js   : orchestrator (multi-queue + per-series APIs)
 *
 * This file is intentionally left empty; index.html now loads the
 * four split files directly. Keeping the path so any old import
 * references continue to resolve without 404.
 * ========================================================= */
