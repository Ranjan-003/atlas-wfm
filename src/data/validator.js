/* =========================================================
 * Data Pipeline: VALIDATOR
 * Canonical rows → issues + summary stats.
 *
 * Five checks (each emits 0..N issues):
 *   1. Missing values             — null/NaN/empty volumes or queues
 *   2. Zero-value alerts          — runs of zeros that look like missing rather than truly zero
 *   3. Spike detection            — per-queue Z-score > threshold and % deviation > threshold
 *   4. Duplicate rows             — same (date, queue, channel) appearing more than once
 *   5. Queue naming inconsistency — different raw strings normalizing to the same canonical key
 *
 * Issue shape:
 *   { severity: 'critical' | 'warning' | 'info', type, message, context }
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Validator = {};

  /* Thresholds (tunable per request) */
  const SPIKE_Z_THRESHOLD       = 3.0;
  const SPIKE_PCT_THRESHOLD     = 0.50;     // 50% deviation from rolling median
  const ZERO_RUN_THRESHOLD      = 3;        // consecutive zeros to flag
  const LEVENSHTEIN_THRESHOLD   = 2;        // string distance to consider two queue names the same

  Validator.run = function (cleanedData) {
    if (!cleanedData || cleanedData.length === 0) {
      return { issues: [{ severity: 'critical', type: 'empty', message: 'No rows after normalization. Check source structure.' }], summary: emptySummary() };
    }

    const issues = []
      .concat(checkMissing(cleanedData))
      .concat(checkZeroRuns(cleanedData))
      .concat(checkSpikes(cleanedData))
      .concat(checkDuplicates(cleanedData))
      .concat(checkNamingInconsistency(cleanedData));

    return { issues, summary: summarize(cleanedData, issues) };
  };

  /* ====================================================
   * 1. MISSING VALUES
   * ==================================================== */
  function checkMissing(rows) {
    let missingVolume = 0, missingQueue = 0, missingDate = 0;
    for (const r of rows) {
      if (r.volume == null || isNaN(r.volume)) missingVolume++;
      if (!r.queue || r.queue === '(unknown)') missingQueue++;
      if (!r.date) missingDate++;
    }
    const out = [];
    if (missingVolume > 0) out.push({ severity: missingVolume / rows.length > 0.05 ? 'critical' : 'warning', type: 'missing_volume', message: `${missingVolume} row${missingVolume>1?'s':''} have missing/invalid volume (${pct(missingVolume,rows.length)}% of dataset)`, context: { count: missingVolume } });
    if (missingQueue > 0)  out.push({ severity: missingQueue / rows.length > 0.05 ? 'critical' : 'warning', type: 'missing_queue', message: `${missingQueue} row${missingQueue>1?'s':''} have no queue identifier`, context: { count: missingQueue } });
    if (missingDate > 0)   out.push({ severity: 'critical', type: 'missing_date', message: `${missingDate} rows have no parseable date`, context: { count: missingDate } });
    return out;
  }

  /* ====================================================
   * 2. ZERO RUNS
   * Consecutive zeros within one queue's time series — usually means
   * data wasn't recorded, not that volume was actually zero.
   * ==================================================== */
  function checkZeroRuns(rows) {
    const byQueue = groupByQueue(rows);
    const out = [];
    for (const [queue, series] of byQueue) {
      series.sort((a,b) => a.date.localeCompare(b.date));
      let runStart = null, runLen = 0, maxRunLen = 0, maxRunStart = null;
      for (let i = 0; i < series.length; i++) {
        if (series[i].volume === 0) {
          if (runStart == null) runStart = series[i].date;
          runLen++;
          if (runLen > maxRunLen) { maxRunLen = runLen; maxRunStart = runStart; }
        } else {
          runStart = null; runLen = 0;
        }
      }
      if (maxRunLen >= ZERO_RUN_THRESHOLD) {
        out.push({
          severity: maxRunLen >= 5 ? 'warning' : 'info',
          type: 'zero_run',
          message: `${queue}: ${maxRunLen} consecutive zero volumes starting ${maxRunStart}`,
          context: { queue, runLength: maxRunLen, startDate: maxRunStart }
        });
      }
    }
    return out;
  }

  /* ====================================================
   * 3. SPIKES (Z-score + % deviation from rolling median)
   * ==================================================== */
  function checkSpikes(rows) {
    const byQueue = groupByQueue(rows);
    const out = [];
    for (const [queue, series] of byQueue) {
      if (series.length < 8) continue;     // need enough data
      series.sort((a,b) => a.date.localeCompare(b.date));
      const vals = series.map(s => s.volume);
      const { mean, std } = stats(vals);
      if (std === 0) continue;

      const flagged = [];
      const winSize = 5;
      for (let i = 0; i < vals.length; i++) {
        const z = (vals[i] - mean) / std;
        // Rolling median window around i
        const lo = Math.max(0, i - winSize);
        const hi = Math.min(vals.length, i + winSize + 1);
        const win = vals.slice(lo, hi).filter((_,k) => k !== (i - lo));
        const med = median(win) || mean;
        const pctDev = med ? Math.abs(vals[i] - med) / med : 0;
        if (Math.abs(z) >= SPIKE_Z_THRESHOLD && pctDev >= SPIKE_PCT_THRESHOLD) {
          flagged.push({ date: series[i].date, value: vals[i], z, pctDev });
        }
      }
      if (flagged.length > 0) {
        out.push({
          severity: flagged.length > 3 ? 'warning' : 'info',
          type: 'spike',
          message: `${queue}: ${flagged.length} spike${flagged.length>1?'s':''} detected (>${SPIKE_Z_THRESHOLD}σ AND >${SPIKE_PCT_THRESHOLD*100}% off rolling median)`,
          context: { queue, count: flagged.length, samples: flagged.slice(0,3) }
        });
      }
    }
    return out;
  }

  /* ====================================================
   * 4. DUPLICATES (same date + queue + channel appearing twice)
   * ==================================================== */
  function checkDuplicates(rows) {
    const seen = new Map();
    const dups = [];
    for (const r of rows) {
      const k = `${r.date}|${r.queue}|${r.channel}`;
      if (seen.has(k)) dups.push({ key: k, row: r, original: seen.get(k) });
      else seen.set(k, r);
    }
    if (dups.length === 0) return [];
    return [{
      severity: dups.length > rows.length * 0.05 ? 'warning' : 'info',
      type: 'duplicate',
      message: `${dups.length} duplicate row${dups.length>1?'s':''} on (date, queue, channel)`,
      context: { count: dups.length, samples: dups.slice(0,3).map(d => d.key) }
    }];
  }

  /* ====================================================
   * 5. QUEUE NAMING INCONSISTENCY
   * Group raw queue strings by canonical key (lowercase + non-alnum stripped).
   * Also use Levenshtein for fuzzy near-duplicates.
   * ==================================================== */
  function checkNamingInconsistency(rows) {
    const groups = new Map();
    for (const r of rows) {
      const canon = canonicalize(r.queue);
      if (!canon) continue;
      if (!groups.has(canon)) groups.set(canon, new Set());
      groups.get(canon).add(r.queue);
    }
    const issues = [];
    for (const [canon, variants] of groups) {
      if (variants.size > 1) {
        issues.push({
          severity: 'warning',
          type: 'naming_inconsistency',
          message: `Queue "${[...variants][0]}" appears under ${variants.size} different spellings: ${[...variants].join(' / ')}`,
          context: { canonical: canon, variants: [...variants] }
        });
      }
    }
    // Levenshtein near-duplicates across DIFFERENT canonical keys
    const canonKeys = [...groups.keys()];
    for (let i = 0; i < canonKeys.length; i++) {
      for (let j = i + 1; j < canonKeys.length; j++) {
        const d = levenshtein(canonKeys[i], canonKeys[j]);
        if (d > 0 && d <= LEVENSHTEIN_THRESHOLD && Math.min(canonKeys[i].length, canonKeys[j].length) > 4) {
          const aRep = [...groups.get(canonKeys[i])][0];
          const bRep = [...groups.get(canonKeys[j])][0];
          issues.push({
            severity: 'info',
            type: 'naming_fuzzy',
            message: `Possible typo: "${aRep}" vs "${bRep}" differ by ${d} character${d>1?'s':''}`,
            context: { a: aRep, b: bRep, distance: d }
          });
        }
      }
    }
    return issues;
  }

  /* ====================================================
   * HELPERS
   * ==================================================== */
  function groupByQueue(rows) {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.queue)) m.set(r.queue, []);
      m.get(r.queue).push(r);
    }
    return m;
  }
  function stats(arr) {
    if (!arr.length) return { mean: 0, std: 0 };
    const mean = arr.reduce((s,v)=>s+v, 0) / arr.length;
    const variance = arr.reduce((s,v)=>s + (v-mean)*(v-mean), 0) / arr.length;
    return { mean, std: Math.sqrt(variance) };
  }
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a,b)=>a-b);
    return s[Math.floor(s.length / 2)];
  }
  function canonicalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const dp = Array.from({length: m+1}, (_,i) => [i].concat(new Array(n).fill(0)));
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i-1] === b[j-1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
      }
    }
    return dp[m][n];
  }
  function pct(num, den) { return den ? ((num/den)*100).toFixed(1) : '0'; }

  function summarize(rows, issues) {
    const byQueue = groupByQueue(rows);
    const volumes = rows.map(r => r.volume);
    const { mean, std } = stats(volumes);
    return {
      rowCount: rows.length,
      uniqueQueues: byQueue.size,
      uniqueDates: new Set(rows.map(r => r.date)).size,
      uniqueChannels: new Set(rows.map(r => r.channel)).size,
      volumeMean: mean,
      volumeStd: std,
      volumeMin: Math.min(...volumes),
      volumeMax: Math.max(...volumes),
      issueCount: issues.length,
      criticalCount: issues.filter(i => i.severity === 'critical').length,
      warningCount: issues.filter(i => i.severity === 'warning').length
    };
  }
  function emptySummary() {
    return { rowCount: 0, uniqueQueues: 0, uniqueDates: 0, uniqueChannels: 0, volumeMean: 0, volumeStd: 0, volumeMin: 0, volumeMax: 0, issueCount: 0, criticalCount: 0, warningCount: 0 };
  }

  WFM.CSV = WFM.CSV || {};
  WFM.CSV.Validator = Validator;
})(window.WFM = window.WFM || {});
