/* =========================================================
 * Forecasting · MODELS
 *
 * Every model is a pure function:
 *   model(history: number[], horizon: number, opts?: object) → number[]
 *
 * No side effects, no I/O. Models do not handle missing values — that's
 * the orchestrator's job. Pass clean numeric arrays only.
 *
 * Library:
 *   1. movingAverageModel        — simple MA over window
 *   2. weightedMovingAverageModel — exponentially-decreasing weights
 *   3. regressionModel           — linear trend extrapolation
 *   4. seasonalityModel          — decomposition: trend + seasonal index
 *   5. holtWintersModel          — triple-exponential smoothing
 *   6. ensembleModel             — variance-weighted blend of the others
 *
 *  Each model also exports a `fit(history, opts)` that returns the
 *  fitted in-sample series (used by the selector during backtesting).
 * ========================================================= */
(function (WFM) {
  'use strict';
  const F = WFM.Forecasting || {};
  const S = F.Stats;

  const Models = {};

  /* ====================================================
   * 1. MOVING AVERAGE
   * yhat[t] = mean(last `window` observations)
   * Best for: stable demand, no trend, no seasonality.
   * ==================================================== */
  Models.movingAverageModel = function (history, horizon, opts) {
    opts = opts || {};
    const window = Math.min(opts.window || 7, history.length);
    if (window === 0) return new Array(horizon).fill(0);
    const tail = history.slice(-window);
    const mean = tail.reduce((s, v) => s + v, 0) / window;
    return new Array(horizon).fill(mean);
  };

  Models.movingAverageModel.fit = function (history, opts) {
    const window = (opts && opts.window) || 7;
    const fitted = [];
    for (let i = 0; i < history.length; i++) {
      const lo = Math.max(0, i - window + 1);
      const slice = history.slice(lo, i + 1);
      fitted.push(slice.reduce((s, v) => s + v, 0) / slice.length);
    }
    return fitted;
  };

  /* ====================================================
   * 2. WEIGHTED MOVING AVERAGE (exponential decay)
   * yhat[t] = Σ w_i * history[i]  where w_i decays geometrically with age
   * Best for: gentle trend, recent values matter more.
   * ==================================================== */
  Models.weightedMovingAverageModel = function (history, horizon, opts) {
    opts = opts || {};
    const window = Math.min(opts.window || 7, history.length);
    const alpha = opts.alpha || 0.5;          // decay; higher = more recent-heavy
    if (window === 0) return new Array(horizon).fill(0);

    const tail = history.slice(-window);
    let weightedSum = 0, weightTotal = 0;
    for (let i = 0; i < tail.length; i++) {
      const age = tail.length - 1 - i;        // most recent has age 0
      const w = Math.pow(1 - alpha, age);
      weightedSum += w * tail[i];
      weightTotal += w;
    }
    const mean = weightedSum / weightTotal;
    return new Array(horizon).fill(mean);
  };

  Models.weightedMovingAverageModel.fit = function (history, opts) {
    const window = (opts && opts.window) || 7;
    const alpha  = (opts && opts.alpha)  || 0.5;
    const fitted = [];
    for (let i = 0; i < history.length; i++) {
      const lo = Math.max(0, i - window + 1);
      const slice = history.slice(lo, i + 1);
      let ws = 0, wt = 0;
      for (let j = 0; j < slice.length; j++) {
        const age = slice.length - 1 - j;
        const w = Math.pow(1 - alpha, age);
        ws += w * slice[j]; wt += w;
      }
      fitted.push(ws / wt);
    }
    return fitted;
  };

  /* ====================================================
   * 3. LINEAR REGRESSION (trend extrapolation)
   * Fit y = a + b*t on history, project forward.
   * Best for: clear monotonic trend, low noise.
   * ==================================================== */
  Models.regressionModel = function (history, horizon, opts) {
    if (history.length < 3) {
      const mean = history.reduce((s,v)=>s+v, 0) / Math.max(1, history.length);
      return new Array(horizon).fill(mean);
    }
    const t = S.detectTrend(history);
    const n = history.length;
    const out = [];
    for (let h = 0; h < horizon; h++) {
      const x = n + h;
      out.push(Math.max(0, t.intercept + t.slope * x));
    }
    return out;
  };

  Models.regressionModel.fit = function (history) {
    const t = S.detectTrend(history);
    return history.map((_, i) => Math.max(0, t.intercept + t.slope * i));
  };

  /* ====================================================
   * 4. SEASONALITY MODEL — trend + seasonal index
   * Decomposes history into trend + seasonal, projects trend forward
   * via regression on the trend curve, then re-applies seasonal index.
   * Best for: strong weekly/monthly cycle.
   * ==================================================== */
  Models.seasonalityModel = function (history, horizon, opts) {
    const period = (opts && opts.period) || 7;
    if (history.length < period * 2) {
      // Fall back to naive seasonal repeat
      const out = [];
      for (let i = 0; i < horizon; i++) out.push(history[history.length - period + (i % period)]);
      return out.map(v => v == null ? history[history.length - 1] : v);
    }

    const decomp = S.decompose(history, period);
    // Project the trend forward via linear regression on the trend curve
    const trendTrend = S.detectTrend(decomp.trend);
    const n = history.length;

    const out = [];
    for (let h = 0; h < horizon; h++) {
      const x = n + h;
      const trendProj = trendTrend.intercept + trendTrend.slope * x;
      const phase = (n + h) % period;
      out.push(Math.max(0, trendProj + decomp.seasonalIdx[phase]));
    }
    return out;
  };

  Models.seasonalityModel.fit = function (history, opts) {
    const period = (opts && opts.period) || 7;
    if (history.length < period * 2) return history.slice();
    const decomp = S.decompose(history, period);
    return history.map((_, i) => decomp.trend[i] + decomp.seasonalIdx[i % period]);
  };

  /* ====================================================
   * 5. HOLT-WINTERS (additive triple exponential smoothing)
   * Level + Trend + Seasonality components, each updated recursively.
   *
   *   L_t = α (y_t − S_{t−p}) + (1−α)(L_{t−1} + T_{t−1})
   *   T_t = β (L_t − L_{t−1}) + (1−β) T_{t−1}
   *   S_t = γ (y_t − L_t) + (1−γ) S_{t−p}
   *
   * Forecast h steps ahead: yhat_{t+h} = L_t + h T_t + S_{t+h−p}
   * Best for: data with both trend and seasonality, moderate noise.
   * ==================================================== */
  Models.holtWintersModel = function (history, horizon, opts) {
    opts = opts || {};
    const period = opts.period || 7;
    const alpha  = opts.alpha  || 0.3;
    const beta   = opts.beta   || 0.1;
    const gamma  = opts.gamma  || 0.2;
    const n = history.length;

    if (n < period * 2) {
      // Fallback to seasonality model when too few cycles
      return Models.seasonalityModel(history, horizon, { period });
    }

    // Initialize L, T, S using the first two seasonal cycles
    const c1 = history.slice(0, period).reduce((s,v)=>s+v, 0) / period;
    const c2 = history.slice(period, period * 2).reduce((s,v)=>s+v, 0) / period;
    let L = c1;
    let T = (c2 - c1) / period;
    const S_arr = history.slice(0, period).map(v => v - c1);

    // Smooth through history
    for (let i = period; i < n; i++) {
      const lastL = L;
      const seasonalPrev = S_arr[(i - period) % period];
      L = alpha * (history[i] - seasonalPrev) + (1 - alpha) * (L + T);
      T = beta  * (L - lastL) + (1 - beta) * T;
      S_arr[i % period] = gamma * (history[i] - L) + (1 - gamma) * seasonalPrev;
    }

    // Forecast forward
    const out = [];
    for (let h = 1; h <= horizon; h++) {
      const seasonal = S_arr[(n + h - 1) % period];
      out.push(Math.max(0, L + h * T + seasonal));
    }
    return out;
  };

  Models.holtWintersModel.fit = function (history, opts) {
    opts = opts || {};
    const period = opts.period || 7;
    const alpha  = opts.alpha  || 0.3;
    const beta   = opts.beta   || 0.1;
    const gamma  = opts.gamma  || 0.2;
    const n = history.length;
    if (n < period * 2) return history.slice();

    const fitted = new Array(n).fill(0);
    const c1 = history.slice(0, period).reduce((s,v)=>s+v, 0) / period;
    const c2 = history.slice(period, period * 2).reduce((s,v)=>s+v, 0) / period;
    let L = c1, T = (c2 - c1) / period;
    const S_arr = history.slice(0, period).map(v => v - c1);

    for (let i = 0; i < period; i++) fitted[i] = L + T * (i - period) + S_arr[i];
    for (let i = period; i < n; i++) {
      const seasonalPrev = S_arr[(i - period) % period];
      fitted[i] = L + T + seasonalPrev;          // one-step-ahead fit
      const lastL = L;
      L = alpha * (history[i] - seasonalPrev) + (1 - alpha) * (L + T);
      T = beta  * (L - lastL) + (1 - beta) * T;
      S_arr[i % period] = gamma * (history[i] - L) + (1 - gamma) * seasonalPrev;
    }
    return fitted;
  };

  /* ====================================================
   * 6. ENSEMBLE — variance-weighted blend
   * Runs each candidate model, weights its prediction inversely to its
   * validation error (lower error = higher weight).
   *
   * opts.candidates = list of model names (default: all)
   * opts.weights    = pre-computed weights map; overrides validation
   * ==================================================== */
  Models.ensembleModel = function (history, horizon, opts) {
    opts = opts || {};
    const candidates = opts.candidates || ['movingAverageModel', 'weightedMovingAverageModel', 'regressionModel', 'seasonalityModel', 'holtWintersModel'];
    const period = opts.period || 7;

    // Generate forecasts for each candidate
    const forecasts = {};
    for (const name of candidates) {
      try { forecasts[name] = Models[name](history, horizon, { period }); }
      catch (_) { /* skip failed models */ }
    }
    const names = Object.keys(forecasts);
    if (names.length === 0) return new Array(horizon).fill(0);
    if (names.length === 1) return forecasts[names[0]];

    // Weights
    const weights = opts.weights ||
      names.reduce((acc, n) => (acc[n] = 1 / names.length, acc), {});

    const total = names.reduce((s, n) => s + (weights[n] || 0), 0) || 1;
    const out = new Array(horizon).fill(0);
    for (const name of names) {
      const w = (weights[name] || 0) / total;
      for (let h = 0; h < horizon; h++) out[h] += w * forecasts[name][h];
    }
    return out.map(v => Math.max(0, v));
  };

  Models.ensembleModel.fit = function (history, opts) {
    opts = opts || {};
    const candidates = opts.candidates || ['movingAverageModel', 'weightedMovingAverageModel', 'regressionModel', 'seasonalityModel', 'holtWintersModel'];
    const period = opts.period || 7;
    const fits = candidates.map(name => {
      try { return Models[name].fit(history, { period }); } catch (_) { return null; }
    }).filter(Boolean);
    if (fits.length === 0) return history.slice();
    return history.map((_, i) => fits.reduce((s, f) => s + (f[i] || 0), 0) / fits.length);
  };

  /* ====================================================
   * NAÏVE SEASONAL — keep as a baseline (separate from main library)
   * Useful for: extreme cyclic data; also used by selector as floor model.
   * ==================================================== */
  Models.naiveSeasonalModel = function (history, horizon, opts) {
    const period = (opts && opts.period) || 7;
    const out = [];
    for (let h = 0; h < horizon; h++) {
      const idx = history.length - period + (h % period);
      out.push(idx >= 0 ? history[idx] : history[history.length - 1] || 0);
    }
    return out;
  };
  Models.naiveSeasonalModel.fit = function (history, opts) {
    const period = (opts && opts.period) || 7;
    return history.map((_, i) => i < period ? history[i] : history[i - period]);
  };

  /* ====================================================
   * Model metadata for the selector and the UI
   * ==================================================== */
  Models.META = {
    movingAverageModel:         { label: 'Moving Average',        bestFor: 'Stable demand, no trend or seasonality' },
    weightedMovingAverageModel: { label: 'Weighted MA',           bestFor: 'Gentle trend with noise; recent emphasis' },
    regressionModel:            { label: 'Linear Regression',     bestFor: 'Clear monotonic trend, low cycle' },
    seasonalityModel:           { label: 'Seasonal Decomposition', bestFor: 'Strong weekly/monthly cycle' },
    holtWintersModel:           { label: 'Holt-Winters',          bestFor: 'Trend + seasonality combined' },
    ensembleModel:              { label: 'Ensemble',              bestFor: 'Mixed signal, hedge against single-model risk' },
    naiveSeasonalModel:         { label: 'Naïve Seasonal',        bestFor: 'Baseline; pure repeat-last-cycle' }
  };

  WFM.Forecasting.Models = Models;
})(window.WFM = window.WFM || {});
