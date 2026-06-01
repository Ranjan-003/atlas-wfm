/* =========================================================
 * Forecasting · SELECTOR
 * Analyzes a series, picks the right model via walk-forward backtest.
 *
 *   analyze(history, period)    → pattern profile (trend, seasonality, volatility, n, anomalies)
 *   backtest(history, models)   → per-model error metrics on a held-out validation slice
 *   selectModel(history, opts)  → { winner, scores, profile, reasons }
 *
 * Walk-forward design: train on first 80% of history, predict next 20%, compute MAPE+WAPE+MASE.
 * Lower error wins, but a small penalty is added for very flexible models when the data is short
 * (Occam's razor — prefer simpler models on thin data).
 * ========================================================= */
(function (WFM) {
  'use strict';
  const F = WFM.Forecasting;
  const S = F.Stats;
  const M = F.Models;

  const Selector = {};

  /* ====================================================
   * 1. PATTERN ANALYSIS
   * ==================================================== */
  Selector.analyze = function (history, period) {
    period = period || 7;
    const n = history.length;
    const desc = S.describe(history);
    const trend = S.detectTrend(history);
    const seasonality = S.detectSeasonality(history, period);
    const volatility = S.detectVolatility(history);
    const anomalies = S.anomalies(history, 3.5, { period: seasonality.period, deseason: true });

    // Data-quality flags
    const sparsity = history.filter(v => v === 0).length / n;
    const intermittent = sparsity > 0.30;

    return { n, desc, trend, seasonality, volatility, anomalies, sparsity, intermittent };
  };

  /* ====================================================
   * 2. BACKTEST — walk-forward, train/val split = 80/20
   * (with a minimum validation length so we always test on ≥ 7 days)
   * ==================================================== */
  Selector.backtest = function (history, models, opts) {
    opts = opts || {};
    const period = opts.period || 7;
    const n = history.length;

    // Validation length: 20% of history, but at least 7 and at most 28 days
    const valLen = Math.max(7, Math.min(28, Math.floor(n * 0.20)));
    if (n - valLen < period * 2) {
      // Not enough training data — degrade gracefully
      return { skipped: true, reason: `Need ≥ ${period * 2} training points; have ${n - valLen}.` };
    }

    const train = history.slice(0, n - valLen);
    const actual = history.slice(n - valLen);

    const results = {};
    for (const name of models) {
      const fn = M[name];
      if (!fn) continue;
      try {
        const pred = fn(train, valLen, { period });
        const err = S.errors(actual, pred);
        results[name] = err;
      } catch (e) {
        results[name] = { error: e.message, wape: Infinity, mape: Infinity, mae: Infinity, rmse: Infinity, mase: Infinity };
      }
    }
    return { results, valLen, trainLen: train.length };
  };

  /* ====================================================
   * 3. SELECT MODEL
   * Backtests all eligible models, applies parsimony penalties,
   * picks the winner, and produces human-readable reasoning.
   * ==================================================== */
  Selector.selectModel = function (history, opts) {
    opts = opts || {};
    const period = opts.period || 7;
    const profile = Selector.analyze(history, period);

    // Which models are eligible given the data?
    const candidates = [];
    candidates.push('movingAverageModel');                    // always eligible
    candidates.push('weightedMovingAverageModel');            // always eligible
    if (profile.n >= 8) candidates.push('regressionModel');
    if (profile.n >= period * 2) candidates.push('seasonalityModel');
    if (profile.n >= period * 2) candidates.push('holtWintersModel');
    if (candidates.length >= 2) candidates.push('ensembleModel');
    candidates.push('naiveSeasonalModel');                    // baseline always included for sanity

    // Run backtest
    const bt = Selector.backtest(history, candidates, { period });
    if (bt.skipped) {
      // Too little data → choose simplest model with no error checking
      return {
        winner: 'movingAverageModel',
        scores: {},
        profile,
        reasons: [`Insufficient data for backtest (${bt.reason}) → defaulted to Moving Average`],
        confident: false,
        candidates
      };
    }

    // Score each model: WAPE primary, MAPE secondary, MASE tertiary
    const scores = {};
    for (const [name, err] of Object.entries(bt.results)) {
      const wape  = isFinite(err.wape)  ? err.wape  : 1.0;
      const mape  = isFinite(err.mape)  ? err.mape  : 1.0;
      const mase  = isFinite(err.mase)  ? err.mase  : 2.0;
      let composite = 0.6 * wape + 0.3 * mape + 0.1 * Math.min(1, mase / 2);

      // Parsimony penalty: Holt-Winters and Ensemble pay a small tax when n is small
      if (name === 'holtWintersModel' && profile.n < 28) composite *= 1.04;
      if (name === 'ensembleModel'    && profile.n < 21) composite *= 1.03;

      // Penalize naive baseline slightly so it only wins when truly the best
      if (name === 'naiveSeasonalModel') composite *= 1.02;

      scores[name] = { composite, ...err };
    }

    const sorted = Object.entries(scores).sort((a, b) => a[1].composite - b[1].composite);
    const winner = sorted[0][0];

    // Reasoning
    const reasons = buildReasons(winner, profile, scores);

    // Confidence in the SELECTION (not the forecast itself)
    const top = sorted[0][1].composite;
    const second = sorted[1]?.[1].composite ?? top + 1;
    const margin = second - top;
    const confident = profile.n >= 21 && margin > 0.02 && top < 0.30;

    return { winner, scores, profile, reasons, confident, candidates, valLen: bt.valLen, trainLen: bt.trainLen };
  };

  /* ====================================================
   * Reasoning — translate selection into plain English
   * ==================================================== */
  function buildReasons(winner, profile, scores) {
    const r = [];
    const meta = M.META[winner];
    r.push(`${meta.label} selected: ${meta.bestFor.toLowerCase()}.`);

    // Trend
    if (profile.trend.direction === 'up') {
      r.push(`Trend detected: increasing by ${(profile.trend.pctPerStep * 100).toFixed(2)}% per period (R²=${profile.trend.r2.toFixed(2)}).`);
    } else if (profile.trend.direction === 'down') {
      r.push(`Trend detected: decreasing by ${(Math.abs(profile.trend.pctPerStep) * 100).toFixed(2)}% per period (R²=${profile.trend.r2.toFixed(2)}).`);
    } else {
      r.push(`No significant trend (slope effectively flat).`);
    }

    // Seasonality
    if (profile.seasonality.detected) {
      r.push(`Seasonality detected at period ${profile.seasonality.period} (autocorrelation ${profile.seasonality.strength.toFixed(2)}).`);
    } else {
      r.push(`No strong seasonal cycle.`);
    }

    // Volatility
    const v = profile.volatility;
    if (v.regime === 'high') {
      r.push(`High volatility (CoV=${v.cov.toFixed(2)}) — confidence reduced.`);
    } else if (v.regime === 'medium') {
      r.push(`Moderate volatility (CoV=${v.cov.toFixed(2)}).`);
    } else {
      r.push(`Low volatility (CoV=${v.cov.toFixed(2)}) — confidence boosted.`);
    }

    // Anomalies
    if (profile.anomalies.length > 0) {
      const spikes = profile.anomalies.filter(a => a.type === 'spike').length;
      const drops  = profile.anomalies.filter(a => a.type === 'drop').length;
      r.push(`${profile.anomalies.length} anomal${profile.anomalies.length === 1 ? 'y' : 'ies'} flagged (${spikes} spike${spikes !== 1 ? 's' : ''}, ${drops} drop${drops !== 1 ? 's' : ''}).`);
    }

    // Winner accuracy
    const w = scores[winner];
    if (w && isFinite(w.wape)) {
      r.push(`Validation accuracy: ${((1 - w.wape) * 100).toFixed(1)}% (WAPE ${(w.wape * 100).toFixed(2)}%, MAPE ${(w.mape * 100).toFixed(2)}%, MAE ${w.mae.toFixed(1)}).`);
    }

    return r;
  }

  WFM.Forecasting.Selector = Selector;
})(window.WFM = window.WFM || {});
