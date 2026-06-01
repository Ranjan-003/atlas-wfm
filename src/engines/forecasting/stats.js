/* =========================================================
 * Forecasting · STATS
 * Shared math primitives used by every model and the selector.
 *
 * Exported on WFM.Forecasting.Stats:
 *   describe(arr)                  → basic descriptive stats
 *   decompose(arr, period)         → trend + seasonal + residual (additive)
 *   detectTrend(arr)               → { slope, pctPerStep, direction, strength }
 *   detectSeasonality(arr, period) → { detected, strength, period }
 *   detectVolatility(arr)          → { cov, regime: 'low'|'medium'|'high' }
 *   anomalies(arr, k)              → [{ index, value, z, type }]
 *   errors(actual, pred)           → { mape, smape, wape, mae, rmse, mase }
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Stats = {};

  /* ====================================================
   * DESCRIPTIVE
   * ==================================================== */
  Stats.describe = function (arr) {
    const a = arr.filter(v => v != null && !isNaN(v));
    if (a.length === 0) return { n: 0, mean: 0, std: 0, min: 0, max: 0, median: 0 };
    const n = a.length;
    const sum = a.reduce((s, v) => s + v, 0);
    const mean = sum / n;
    const variance = a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
    const std = Math.sqrt(variance);
    const sorted = [...a].sort((x, y) => x - y);
    const median = n % 2 === 1 ? sorted[(n - 1) >> 1] : (sorted[n/2 - 1] + sorted[n/2]) / 2;
    return { n, mean, std, min: sorted[0], max: sorted[n - 1], median, sum, cv: mean !== 0 ? std / Math.abs(mean) : 0 };
  };

  /* ====================================================
   * LINEAR TREND (least-squares regression of y on x=0..n-1)
   * Returns slope per step plus % growth per step relative to mean.
   * ==================================================== */
  Stats.detectTrend = function (arr) {
    const n = arr.length;
    if (n < 4) return { slope: 0, intercept: arr[0] || 0, pctPerStep: 0, direction: 'flat', strength: 0, r2: 0 };

    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += i; sy += arr[i]; sxx += i * i; sxy += i * arr[i];
    }
    const denom = n * sxx - sx * sx;
    const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
    const intercept = (sy - slope * sx) / n;

    // R² for how well a linear fit explains variance
    const meanY = sy / n;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      const yhat = intercept + slope * i;
      ssTot += (arr[i] - meanY) ** 2;
      ssRes += (arr[i] - yhat) ** 2;
    }
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    const pctPerStep = meanY !== 0 ? slope / Math.abs(meanY) : 0;
    let direction = 'flat';
    if (Math.abs(pctPerStep) >= 0.005 && r2 >= 0.2) {
      direction = slope > 0 ? 'up' : 'down';
    }
    return { slope, intercept, pctPerStep, direction, strength: r2, r2 };
  };

  /* ====================================================
   * SEASONALITY (autocorrelation at lag = period)
   * Strong positive ACF at the candidate lag ⇒ seasonality.
   * Also scans neighboring lags to pick the best period if not provided.
   * ==================================================== */
  Stats.autocorrelation = function (arr, lag) {
    const n = arr.length;
    if (n <= lag + 1) return 0;
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      den += (arr[i] - mean) * (arr[i] - mean);
      if (i + lag < n) num += (arr[i] - mean) * (arr[i + lag] - mean);
    }
    return den !== 0 ? num / den : 0;
  };

  Stats.detectSeasonality = function (arr, hintedPeriod) {
    const n = arr.length;
    if (n < 14) return { detected: false, strength: 0, period: hintedPeriod || 7 };

    // Candidate periods to try. Daily contact-center data → weekly (7) is most common.
    // Also try 14, 28 (bi-weekly, monthly-ish).
    const candidates = hintedPeriod ? [hintedPeriod] : [7, 14, 28];
    let best = { period: hintedPeriod || 7, acf: 0 };
    for (const p of candidates) {
      if (n <= p * 2) continue;
      const acf = Stats.autocorrelation(arr, p);
      if (acf > best.acf) best = { period: p, acf };
    }
    // Threshold: ACF > 0.30 at the lag = meaningful seasonality
    return {
      detected: best.acf >= 0.30,
      strength: Math.max(0, best.acf),
      period: best.period
    };
  };

  /* ====================================================
   * VOLATILITY — coefficient of variation classification
   * ==================================================== */
  Stats.detectVolatility = function (arr) {
    const d = Stats.describe(arr);
    const cov = d.cv;
    let regime = 'low';
    if (cov > 0.50) regime = 'high';
    else if (cov > 0.25) regime = 'medium';
    return { cov, regime, std: d.std, mean: d.mean };
  };

  /* ====================================================
   * DECOMPOSITION — classical additive
   * y = trend + seasonal + residual
   *
   * trend     = centered moving average of size = period
   * seasonal  = mean detrended value per phase within period
   * residual  = y − trend − seasonal
   * ==================================================== */
  Stats.decompose = function (arr, period) {
    const n = arr.length;
    period = period || 7;
    if (n < period * 2) {
      // Not enough cycles → return trivial decomp
      const mean = arr.reduce((s, v) => s + v, 0) / n;
      return { trend: arr.map(() => mean), seasonal: arr.map(() => 0), residual: arr.map(v => v - mean), period };
    }

    // 1. Trend via centered moving average
    const half = Math.floor(period / 2);
    const trend = new Array(n).fill(null);
    for (let i = half; i < n - half; i++) {
      let s = 0, c = 0;
      for (let j = i - half; j <= i + half; j++) { s += arr[j]; c++; }
      trend[i] = s / c;
    }
    // Pad edges with nearest valid
    for (let i = 0; i < half; i++) trend[i] = trend[half];
    for (let i = n - half; i < n; i++) trend[i] = trend[n - half - 1];

    // 2. Seasonal: average detrended value per phase (0..period-1)
    const phaseSums = new Array(period).fill(0);
    const phaseCounts = new Array(period).fill(0);
    for (let i = 0; i < n; i++) {
      const detrended = arr[i] - trend[i];
      const phase = i % period;
      phaseSums[phase] += detrended;
      phaseCounts[phase]++;
    }
    const seasonalIdx = phaseSums.map((s, k) => phaseCounts[k] > 0 ? s / phaseCounts[k] : 0);
    // Center so seasonal indices sum to zero (additive decomposition convention)
    const seasonalMean = seasonalIdx.reduce((s, v) => s + v, 0) / period;
    const seasonal = arr.map((_, i) => seasonalIdx[i % period] - seasonalMean);

    // 3. Residual
    const residual = arr.map((v, i) => v - trend[i] - seasonal[i]);

    return { trend, seasonal, residual, seasonalIdx: seasonalIdx.map(v => v - seasonalMean), period };
  };

  /* ====================================================
   * ANOMALY DETECTION — MAD-based with type classification
   * Returns: [{ index, value, z, type: 'spike'|'drop' }]
   *
   * If a strong seasonal cycle exists in the series, we first deseasonalize
   * (subtract the seasonal index of the appropriate phase) and detect
   * anomalies on the residual — so a regular Sunday dip isn't flagged.
   * ==================================================== */
  Stats.anomalies = function (arr, k, opts) {
    k = k || 3.5;
    opts = opts || {};
    const a = arr.filter(v => v != null && !isNaN(v));
    if (a.length < 7) return [];

    // Optionally deseasonalize first
    let signal = arr.slice();
    if (opts.deseason !== false) {
      const periodHint = opts.period || 7;
      const season = Stats.detectSeasonality(arr.filter(v => v != null && !isNaN(v)), periodHint);
      if (season.detected && season.strength >= 0.30 && arr.length >= season.period * 2) {
        const decomp = Stats.decompose(arr.map(v => v == null ? 0 : v), season.period);
        signal = arr.map((v, i) => v == null ? null : v - decomp.seasonalIdx[i % season.period]);
      }
    }

    // Rolling 7-point window for local MAD on the (possibly deseasonalized) signal
    const windowSize = 7;
    const out = [];
    for (let i = 0; i < signal.length; i++) {
      const v = signal[i];
      const origV = arr[i];
      if (v == null || isNaN(v)) continue;
      const lo = Math.max(0, i - windowSize);
      const hi = Math.min(signal.length, i + windowSize + 1);
      const window = signal.slice(lo, hi).filter(x => x != null && !isNaN(x));
      if (window.length < 3) continue;

      const med = median(window);
      const deviations = window.map(x => Math.abs(x - med));
      const mad = median(deviations) || 1;
      const z = 0.6745 * (v - med) / mad;       // modified z-score (Iglewicz & Hoaglin)

      if (Math.abs(z) > k) {
        out.push({ index: i, value: origV, z, type: z > 0 ? 'spike' : 'drop' });
      }
    }
    return out;
  };

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length;
    return m % 2 === 1 ? s[(m - 1) >> 1] : (s[m/2 - 1] + s[m/2]) / 2;
  }
  Stats._median = median;

  /* ====================================================
   * ERROR METRICS
   * ==================================================== */
  Stats.errors = function (actual, pred) {
    const n = Math.min(actual.length, pred.length);
    if (n === 0) return { mape: NaN, smape: NaN, wape: NaN, mae: NaN, rmse: NaN, mase: NaN };

    let sumAbsErr = 0, sumAbsAct = 0, sumSq = 0, sumPct = 0, sumSmape = 0, pctCount = 0;
    for (let i = 0; i < n; i++) {
      const a = actual[i], p = pred[i];
      if (a == null || p == null || isNaN(a) || isNaN(p)) continue;
      const err = a - p;
      sumAbsErr += Math.abs(err);
      sumAbsAct += Math.abs(a);
      sumSq += err * err;
      if (Math.abs(a) > 1e-6) { sumPct += Math.abs(err / a); pctCount++; }
      const denom = (Math.abs(a) + Math.abs(p)) / 2;
      if (denom > 1e-6) sumSmape += Math.abs(err) / denom;
    }
    const mae  = sumAbsErr / n;
    const wape = sumAbsAct > 0 ? sumAbsErr / sumAbsAct : NaN;
    const mape = pctCount  > 0 ? sumPct / pctCount     : NaN;
    const smape = sumSmape / n;
    const rmse = Math.sqrt(sumSq / n);

    // MASE — Mean Absolute Scaled Error using naive lag-1 forecast as scale
    let naiveErr = 0, naiveCount = 0;
    for (let i = 1; i < actual.length; i++) {
      if (actual[i] == null || actual[i-1] == null) continue;
      naiveErr += Math.abs(actual[i] - actual[i-1]); naiveCount++;
    }
    const naiveMean = naiveCount > 0 ? naiveErr / naiveCount : 0;
    const mase = naiveMean > 0 ? mae / naiveMean : NaN;

    return { mape, smape, wape, mae, rmse, mase };
  };

  /* ====================================================
   * PERCENTILE
   * ==================================================== */
  Stats.percentile = function (arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    if (!s.length) return 0;
    const idx = Math.max(0, Math.min(s.length - 1, Math.floor(p / 100 * (s.length - 1))));
    return s[idx];
  };

  WFM.Forecasting = WFM.Forecasting || {};
  WFM.Forecasting.Stats = Stats;
})(window.WFM = window.WFM || {});
