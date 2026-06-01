/* =========================================================
 * Forecasting · ENGINE (orchestrator)
 *
 * PUBLIC API
 * ----------
 * Per-series:
 *   WFM.Forecasting.forecastSeries(values, horizon, opts)
 *     → { yhat, lo, hi, model, modelLabel, accuracy, scores, anomalies,
 *         confidence_interval, confidence: { score, level, drivers },
 *         explanation: string[], warning?, profile }
 *
 * Multi-queue (Phase 2 main entry):
 *   WFM.Forecasting.forecastQueues(cleanedData, opts)
 *     → { forecasts: [...], summary: { total_queues, avg_accuracy, high_risk_queues, ... } }
 *
 * Backward-compatible (used by seed.js + modules/forecasting.js):
 *   WFM.Forecasting.forecast(history, opts)  → { yhat, lo, hi, model, accuracy, scores, anomalies, ... }
 *
 * Edge-case contract:
 *   - n < 4   → warning, no forecast emitted (no hallucination)
 *   - n < 14  → only Moving Average and Weighted MA eligible
 *   - n < 14  → confidence capped at Medium
 *   - very-high-volatility → confidence reduced one level
 * ========================================================= */
(function (WFM) {
  'use strict';
  const F = WFM.Forecasting;
  const S = F.Stats;
  const M = F.Models;
  const Sel = F.Selector;

  /* Minimum points needed for any forecast at all */
  const MIN_POINTS_HARD = 4;
  /* Minimum points needed to claim "reliable" */
  const MIN_POINTS_RELIABLE = 14;

  /* ====================================================
   * forecastSeries — single time-series → forecast bundle
   * ==================================================== */
  F.forecastSeries = function (values, horizon, opts) {
    opts = opts || {};
    horizon = horizon || 14;
    const period = opts.period || 7;

    // 1. Clean: drop nulls/NaN, coerce to numbers
    const rawHistory = (values || []).map(v => (v == null || isNaN(v)) ? null : +v).filter(v => v != null);

    // 1b. Holiday-aware history treatment
    //   opts.historyHolidays  : [{ index, name, impactMult, impactDelta } | null] aligned to rawHistory
    //   opts.forecastHolidays : [{ name, impactMult, impactDelta } | null] aligned to forecast horizon
    //
    // For each historical week tagged with a holiday we have two strategies:
    //   (a) LEARN — if we have ≥2 occurrences of the same-named holiday in history,
    //               keep the week (the model gets a chance to fit its impact).
    //   (b) EXCLUDE — replace with the local median of the surrounding window
    //                 (a single anomalous holiday week pollutes trend/seasonality).
    //
    // The engine decides per-holiday based on occurrence count. The explanation
    // records what it did.
    const historyHolidays = opts.historyHolidays || [];
    const forecastHolidays = opts.forecastHolidays || [];

    const holidayLog = [];
    let history = rawHistory.slice();
    if (historyHolidays.length && historyHolidays.length === rawHistory.length) {
      // Count occurrences of each holiday name across history
      const nameCounts = {};
      historyHolidays.forEach(h => { if (h?.name) nameCounts[h.name] = (nameCounts[h.name] || 0) + 1; });

      // Local-median replacement for excluded weeks
      const localMedian = (idx) => {
        const radius = 4;
        const window = [];
        for (let j = Math.max(0, idx - radius); j < Math.min(rawHistory.length, idx + radius + 1); j++) {
          if (j === idx) continue;
          if (!historyHolidays[j]) window.push(rawHistory[j]);   // only non-holiday neighbors
        }
        if (!window.length) return rawHistory[idx];
        const s = [...window].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };

      for (let i = 0; i < rawHistory.length; i++) {
        const h = historyHolidays[i];
        if (!h) continue;
        const occurrences = nameCounts[h.name] || 0;
        if (occurrences >= 2) {
          holidayLog.push({ index: i, name: h.name, action: 'kept', reason: `${occurrences} prior occurrences — model can learn impact` });
        } else {
          history[i] = localMedian(i);
          holidayLog.push({ index: i, name: h.name, action: 'excluded', reason: 'Single occurrence — replaced with local median to avoid polluting trend' });
        }
      }
    }

    // 2. No-hallucination guards
    if (history.length < MIN_POINTS_HARD) {
      return {
        warning: 'Insufficient data for reliable forecast',
        warningDetail: `Need at least ${MIN_POINTS_HARD} observations; received ${history.length}.`,
        yhat: [], lo: [], hi: [], confidence_interval: [],
        model: null, modelLabel: 'none',
        accuracy: 0, accuracy_score: 0,
        scores: {}, anomalies: [],
        confidence: { score: 0, level: 'Low', drivers: ['Insufficient history'] },
        explanation: ['Cannot produce a forecast — too few data points.']
      };
    }

    // 3. Select model via backtest
    let selection;
    if (opts.forceModel && M[opts.forceModel]) {
      selection = forceSelection(history, opts.forceModel, period);
    } else {
      selection = Sel.selectModel(history, { period });
    }

    // 4. Build the forecast using the winning model
    const winnerName = selection.winner;
    const winnerFn = M[winnerName];
    const rawYhat = winnerFn(history, horizon, { period });

    // 4b. Apply holiday adjustments to the forecast (future weeks)
    const yhat = rawYhat.slice();
    const appliedAdjustments = [];
    if (forecastHolidays.length === yhat.length) {
      for (let i = 0; i < yhat.length; i++) {
        const h = forecastHolidays[i];
        if (!h) continue;
        let adjusted = yhat[i];
        if (h.impactMult != null) adjusted = adjusted * h.impactMult;
        if (h.impactDelta != null) adjusted = adjusted + h.impactDelta;
        adjusted = Math.max(0, adjusted);
        appliedAdjustments.push({
          index: i, name: h.name,
          before: yhat[i],
          after: adjusted,
          factor: h.impactMult,
          delta: h.impactDelta
        });
        yhat[i] = adjusted;
      }
    }

    // 5. Compute residuals (fitted vs actual) for CI band
    const fitted = winnerFn.fit ? winnerFn.fit(history, { period }) : history.slice();
    const residuals = [];
    for (let i = 0; i < history.length; i++) {
      if (fitted[i] != null && history[i] != null) residuals.push(history[i] - fitted[i]);
    }

    // 6. CI: from residual distribution, widened slightly with horizon
    const { lo, hi } = computeCI(yhat, residuals, opts.ci || 0.90);

    // 7. Confidence score (about the forecast, not the model choice)
    const confidence = scoreConfidence(selection.profile, selection.scores[winnerName], history.length, selection.confident);

    // 8. Explanation: combine selector reasoning + horizon caveats
    const explanation = [...selection.reasons];
    if (history.length < MIN_POINTS_RELIABLE) {
      explanation.push(`Limited history (${history.length} points) — confidence capped at ${confidence.level}.`);
    }
    if (horizon > history.length * 0.3) {
      explanation.push(`Forecast horizon (${horizon}) is large relative to history (${history.length}) — uncertainty grows further out.`);
    }
    if (holidayLog.length) {
      const kept = holidayLog.filter(l => l.action === 'kept').length;
      const excluded = holidayLog.filter(l => l.action === 'excluded').length;
      if (kept) explanation.push(`${kept} historical holiday week${kept!==1?'s':''} kept in training — model is learning the impact pattern.`);
      if (excluded) explanation.push(`${excluded} historical holiday week${excluded!==1?'s':''} excluded — only one occurrence in history, not enough to learn from, so replaced with local median.`);
    }
    if (appliedAdjustments.length) {
      explanation.push(`Forecast adjusted for ${appliedAdjustments.length} upcoming holiday week${appliedAdjustments.length!==1?'s':''} using regional holiday calendars.`);
    }

    // 9. Accuracy: 1 − WAPE from the winning model's backtest (NaN-safe)
    const wape = selection.scores[winnerName]?.wape;
    const accuracy = isFinite(wape) ? Math.max(0, 1 - wape) : null;

    // 10. Locked vs Indicative split.
    // Locked window = the immediate near-term period where the forecast is
    // accurate enough to drive scheduling. Beyond it, the forecast is
    // directional (for hiring/capacity, not for shifts).
    const lockedWeeks = Math.max(0, Math.min(yhat.length, opts.lockedWeeks != null ? opts.lockedWeeks : 13));
    const lockedYhat       = yhat.slice(0, lockedWeeks);
    const lockedLo         = lo.slice(0, lockedWeeks);
    const lockedHi         = hi.slice(0, lockedWeeks);
    const indicativeYhat   = yhat.slice(lockedWeeks);
    const indicativeLo     = lo.slice(lockedWeeks);
    const indicativeHi     = hi.slice(lockedWeeks);

    if (indicativeYhat.length > 0) {
      explanation.push(`Forecast split: ${lockedWeeks} weeks locked (intended for scheduling) · ${indicativeYhat.length} weeks indicative (directional — re-run as new actuals arrive).`);
    }

    return {
      yhat,
      lo, hi,
      confidence_interval: yhat.map((_, i) => [lo[i], hi[i]]),
      // Locked vs indicative breakdown
      locked: {
        yhat: lockedYhat,
        lo: lockedLo,
        hi: lockedHi,
        weeks: lockedWeeks
      },
      indicative: {
        yhat: indicativeYhat,
        lo: indicativeLo,
        hi: indicativeHi,
        weeks: indicativeYhat.length
      },
      model: winnerName,
      modelLabel: M.META[winnerName].label,
      accuracy,
      accuracy_score: accuracy,                          // alias for spec
      model_used: winnerName,                            // alias for spec
      scores: simplifyScores(selection.scores),
      anomalies: selection.profile.anomalies,
      confidence,
      explanation,
      profile: {
        n: selection.profile.n,
        trend: selection.profile.trend,
        seasonality: selection.profile.seasonality,
        volatility: selection.profile.volatility,
        intermittent: selection.profile.intermittent
      },
      meta: { trainLen: selection.trainLen, valLen: selection.valLen, candidates: selection.candidates },
      holidayLog,                  // what we did to historical holiday weeks
      forecastAdjustments: appliedAdjustments    // what we did to future weeks
    };
  };

  /* ====================================================
   * forecastQueues — Phase 2 main entry
   *
   * Input shape (from Phase 1 pipeline):
   *   [{ date, queue, volume, channel }]
   *
   * Pivots by queue → forecasts each independently → aggregates summary.
   * ==================================================== */
  F.forecastQueues = function (cleanedData, opts) {
    opts = opts || {};
    const horizon = opts.horizon || 14;
    const period  = opts.period  || 7;

    if (!Array.isArray(cleanedData) || cleanedData.length === 0) {
      return { forecasts: [], summary: emptySummary(), warning: 'No data provided' };
    }

    // 1. Group by (queue, channel) since same queue across channels is a different series
    const groups = new Map();
    for (const r of cleanedData) {
      const key = `${r.queue}||${r.channel || 'voice'}`;
      if (!groups.has(key)) groups.set(key, { queue: r.queue, channel: r.channel || 'voice', rows: [] });
      groups.get(key).rows.push(r);
    }

    // 2. For each group: order by date, extract volume series, run forecastSeries
    const forecasts = [];
    for (const [, g] of groups) {
      g.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const values = g.rows.map(r => +r.volume);
      const dates  = g.rows.map(r => r.date);

      const fs = F.forecastSeries(values, horizon, { period });

      // Future dates: extend from last known date by daily increments (simple, deterministic)
      const futureDates = inferFutureDates(dates, horizon);

      forecasts.push({
        queue:           g.queue,
        channel:         g.channel,
        history_dates:   dates,
        history_volumes: values,
        forecast:        fs.yhat,
        forecast_dates:  futureDates,
        confidence_interval: fs.confidence_interval,
        accuracy_score:  fs.accuracy,
        model_used:      fs.model,
        model_label:     fs.modelLabel,
        explanation:     fs.explanation,
        confidence:      fs.confidence,
        anomalies:       fs.anomalies,
        warning:         fs.warning,
        profile:         fs.profile
      });
    }

    // 3. Summary across all queues
    const summary = buildSummary(forecasts);

    return { forecasts, summary };
  };

  /* ====================================================
   * Backward-compatible forecast()
   * Old shape: { yhat, lo, hi, model, accuracy, anomalies, scores }
   * Now built on top of forecastSeries.
   * ==================================================== */
  F.forecast = function (history, opts) {
    opts = opts || {};
    const horizon = opts.horizon || 14;
    const period  = opts.period  || 7;
    const fs = F.forecastSeries(history, horizon, { period, forceModel: opts.forceModel });

    // Legacy `scores` was a map of name → WAPE; preserve that shape.
    const legacyScores = {};
    for (const [name, s] of Object.entries(fs.scores)) {
      legacyScores[mapNewToOld(name)] = isFinite(s.wape) ? s.wape : 1.0;
    }

    return {
      yhat: fs.yhat,
      lo: fs.lo,
      hi: fs.hi,
      model: mapNewToOld(fs.model),
      modelLabel: fs.modelLabel,
      accuracy: fs.accuracy,
      scores: legacyScores,
      anomalies: fs.anomalies,
      explanation: fs.explanation,
      confidence: fs.confidence,
      warning: fs.warning
    };
  };

  /* ====================================================
   * Helpers
   * ==================================================== */
  function forceSelection(history, modelName, period) {
    // Single-model "backtest" so the explanation includes accuracy
    const bt = Sel.backtest(history, [modelName], { period });
    const profile = Sel.analyze(history, period);
    const scores = {};
    if (!bt.skipped && bt.results[modelName]) {
      scores[modelName] = { composite: bt.results[modelName].wape, ...bt.results[modelName] };
    } else {
      scores[modelName] = { composite: NaN, wape: NaN, mape: NaN, mae: NaN, rmse: NaN, mase: NaN };
    }
    return {
      winner: modelName, scores, profile,
      reasons: [`Model forced: ${M.META[modelName]?.label || modelName}`],
      confident: false, candidates: [modelName],
      valLen: bt.valLen, trainLen: bt.trainLen
    };
  }

  function computeCI(yhat, residuals, level) {
    if (residuals.length === 0) {
      return { lo: yhat.map(v => v), hi: yhat.map(v => v) };
    }
    const tail = (1 - level) / 2 * 100;
    const lo = S.percentile(residuals, tail);
    const hi = S.percentile(residuals, 100 - tail);
    // CI widens with sqrt(horizon) — the standard for random-walk-like series.
    // For h=1 we use the empirical residual; by h=52 the band is ~7.2× wider.
    // This is much more honest than linear widening when we go out to 1-2 years.
    return {
      lo: yhat.map((v, h) => Math.max(0, v + lo * Math.sqrt(h + 1) - h * 0.003 * Math.abs(v))),
      hi: yhat.map((v, h) =>          v + hi * Math.sqrt(h + 1) + h * 0.003 * Math.abs(v))
    };
  }

  function scoreConfidence(profile, winnerScore, n, modelConfident) {
    // Composite of: validation accuracy, volatility regime, data sufficiency
    const wape = winnerScore?.wape;
    const accuracy = isFinite(wape) ? 1 - wape : 0.5;

    let score = accuracy;                                                 // start with validated accuracy
    if (profile.volatility.regime === 'high')   score -= 0.20;
    else if (profile.volatility.regime === 'medium') score -= 0.05;

    if (n < MIN_POINTS_RELIABLE) score -= 0.15;
    else if (n < 21)              score -= 0.05;

    if (profile.intermittent) score -= 0.10;
    if (profile.anomalies.length > profile.n * 0.10) score -= 0.10;       // many anomalies → noisy

    score = Math.max(0, Math.min(1, score));

    let level = 'Low';
    if (score >= 0.75) level = 'High';
    else if (score >= 0.55) level = 'Medium';

    const drivers = [];
    if (isFinite(wape)) drivers.push(`Backtest accuracy: ${((1 - wape) * 100).toFixed(1)}%`);
    drivers.push(`Volatility: ${profile.volatility.regime} (CoV=${profile.volatility.cov.toFixed(2)})`);
    drivers.push(`History: ${n} points`);
    if (profile.intermittent) drivers.push(`Intermittent demand (>30% zeros)`);
    if (profile.anomalies.length > 0) drivers.push(`${profile.anomalies.length} anomalies in history`);

    // Cap at Medium when data is thin even if score is high
    if (n < MIN_POINTS_RELIABLE && level === 'High') level = 'Medium';

    return { score, level, drivers };
  }

  function simplifyScores(scores) {
    const out = {};
    for (const [k, v] of Object.entries(scores)) {
      out[k] = { wape: v.wape, mape: v.mape, mae: v.mae, rmse: v.rmse, mase: v.mase, composite: v.composite };
    }
    return out;
  }

  function inferFutureDates(historyDates, horizon) {
    if (!historyDates.length) return [];
    const last = parseDateLoose(historyDates[historyDates.length - 1]);
    if (!last) return historyDates.slice(0, horizon).map((_, i) => `+${i+1}`);

    // Step = median gap between consecutive history dates (in ms)
    const gaps = [];
    for (let i = 1; i < historyDates.length; i++) {
      const a = parseDateLoose(historyDates[i-1]);
      const b = parseDateLoose(historyDates[i]);
      if (a && b) gaps.push(b - a);
    }
    gaps.sort((a, b) => a - b);
    const stepMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 86400000;     // default 1 day

    const out = [];
    for (let h = 1; h <= horizon; h++) {
      const d = new Date(last.getTime() + h * stepMs);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }
  function parseDateLoose(s) {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function buildSummary(forecasts) {
    const total = forecasts.length;
    const accs = forecasts.map(f => f.accuracy_score).filter(v => v != null && isFinite(v));
    const avgAcc = accs.length ? accs.reduce((s,v)=>s+v, 0) / accs.length : null;

    const highRisk = forecasts.filter(f =>
      f.warning || (f.confidence?.level === 'Low') || (f.profile?.volatility?.regime === 'high')
    );
    const insufficient = forecasts.filter(f => f.warning).length;
    const lowConfidence = forecasts.filter(f => f.confidence?.level === 'Low').length;
    const modelCounts = {};
    for (const f of forecasts) {
      const k = f.model_used || 'none';
      modelCounts[k] = (modelCounts[k] || 0) + 1;
    }
    const channelCounts = {};
    for (const f of forecasts) channelCounts[f.channel] = (channelCounts[f.channel] || 0) + 1;

    return {
      total_queues: total,
      avg_accuracy: avgAcc,
      high_risk_queues: highRisk.map(f => f.queue),
      insufficient_data_queues: forecasts.filter(f => f.warning).map(f => f.queue),
      counts: { total, insufficient, lowConfidence, highRisk: highRisk.length },
      models_used: modelCounts,
      channels: channelCounts
    };
  }

  function emptySummary() {
    return { total_queues: 0, avg_accuracy: null, high_risk_queues: [], insufficient_data_queues: [], counts: {}, models_used: {}, channels: {} };
  }

  /* Map new model identifiers back to the legacy names the UI still uses */
  function mapNewToOld(name) {
    const map = {
      movingAverageModel:         'moving_average',
      weightedMovingAverageModel: 'weighted_moving_average',
      regressionModel:            'regression',
      seasonalityModel:           'seasonal',
      holtWintersModel:           'holt_winters',
      ensembleModel:              'ensemble',
      naiveSeasonalModel:         'naive_seasonal'
    };
    return map[name] || name;
  }

  /* Also expose the model functions at the old names for any legacy callers */
  F.movingAverage = M.movingAverageModel;
  F.naiveSeasonal = M.naiveSeasonalModel;
  F.holtWinters   = M.holtWintersModel;
  F.regression    = M.regressionModel;
  F.seasonal      = M.seasonalityModel;
  F.ensemble      = M.ensembleModel;
  F.detectAnomalies = function (arr, k) { return S.anomalies(arr, k); };
  F.wape = function (a, p) { return S.errors(a, p).wape; };
  F.mape = function (a, p) { return S.errors(a, p).mape; };
  F.mae  = function (a, p) { return S.errors(a, p).mae; };
  F.rmse = function (a, p) { return S.errors(a, p).rmse; };

  WFM.Forecasting = F;
})(window.WFM = window.WFM || {});
