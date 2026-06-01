/* =========================================================
 * Data Pipeline: DETECTOR
 * Parsed rows → detected schema. No data mutation here — only insights.
 *
 * Outputs a Detection object:
 *   {
 *     format: 'wide' | 'long' | 'mixed',
 *     formatConfidence: 0..1,
 *     columns: [{ index, name, role, confidence, sample, nonEmpty, unique, stats }],
 *     timeAxis: {
 *       kind: 'header' | 'column' | 'none',
 *       columnIndex?: number,         // when kind='column'
 *       headerColumns?: number[],      // when kind='header' — indices of time-series columns
 *       pattern?: 'weekly' | 'daily' | 'monthly' | 'quarterly' | 'date' | 'custom',
 *       sequence?: string[],           // raw labels (e.g. ['Week 1','Week 2',...])
 *       inferredDates?: string[]       // ISO dates we mapped them to
 *     },
 *     queueAxis: {
 *       kind: 'column' | 'rowAsQueue' | 'none',
 *       columnIndex?: number
 *     },
 *     valueColumns: number[],          // which columns hold the metric (volume) values
 *     totalColumnIndex: number | null, // detected aggregate column to be excluded
 *     ambiguities: [{ id, q, opts, default }],
 *     assumptions: string[]            // for the audit log
 *   }
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Detector = {};

  /* ---------- Role vocabulary ---------- */
  const ROLES = {
    DATE:        'date',
    INTERVAL:    'interval',
    QUEUE:       'queue',
    CHANNEL:     'channel',
    SITE:        'site',
    AGENT:       'agent',
    VOLUME:      'volume',
    AHT:         'aht',
    SLA:         'sla',
    ABANDON:     'abandonment',
    HANDLED:     'handled',
    OCCUPANCY:   'occupancy',
    SHRINKAGE:   'shrinkage',
    TOTAL:       'total',
    TIME_BUCKET: 'time_bucket',   // a header like "Week 3" that represents a time slice
    UNKNOWN:     'unknown'
  };
  Detector.ROLES = ROLES;

  /* ---------- Header pattern library ----------
   * Each pattern returns either null (no match) or
   *   { kind, index, raw, normalizedLabel }
   * We try them in order; first match wins.
   */
  const HEADER_PATTERNS = [
    { kind: 'weekly',    rx: /^(week|wk|w)[\s_-]*(\d{1,3})$/i,  toIndex: m => +m[2] },
    { kind: 'daily',     rx: /^(day|d)[\s_-]*(\d{1,3})$/i,      toIndex: m => +m[2] },
    { kind: 'monthly',   rx: /^(month|m)[\s_-]*(\d{1,2})$/i,    toIndex: m => +m[2] },
    { kind: 'quarterly', rx: /^q[\s_-]*([1-4])$/i,              toIndex: m => +m[1] },
    { kind: 'monthName', rx: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:[\s_-](\d{2,4}))?$/i,
                         toIndex: m => MONTH_INDEX[m[1].slice(0,3).toLowerCase()] },
    { kind: 'iso_date',  rx: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
                         toIndex: m => Date.UTC(+m[1], +m[2]-1, +m[3]) },
    { kind: 'us_date',   rx: /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/,
                         toIndex: m => {
                           const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
                           return Date.UTC(y, +m[1]-1, +m[2]);
                         } }
  ];
  const MONTH_INDEX = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

  /* ---------- Total / aggregate keywords ---------- */
  const TOTAL_RX = /^(total|grand[\s_-]?total|sum|sub[\s_-]?total|aggregate|cumulative|all)$/i;
  const AVG_RX   = /^(avg|average|mean|median)$/i;

  /* ---------- Header keyword → role hints ----------
   * Used when value heuristics are inconclusive.
   * Regexes are deliberately permissive — they match at start of header,
   * allowing optional suffixes like _sec, _pct, _count common in real CSVs.
   */
  const HEADER_HINTS = [
    [/^(date|day|business[\s_-]?date|report[\s_-]?date)$/i,     ROLES.DATE],
    [/^(time|interval|half[\s_-]?hour|hh\.?mm|time[\s_-]?slot)$/i, ROLES.INTERVAL],
    [/^(queue|skill|line|service|product|department|team|category|lob|tower)([\s_-]?(name|id))?$/i, ROLES.QUEUE],
    [/^(channel|media|contact[\s_-]?type|media[\s_-]?type)$/i, ROLES.CHANNEL],
    [/^(site|location|center|cc|country|region)$/i,          ROLES.SITE],
    [/^(agent|employee|rep|user|advisor)([\s_-]?(id|name))?$/i, ROLES.AGENT],
    [/^(volume|vol|calls?|contacts?|offered|interactions|tickets?|chats?|count|cnt)([\s_-]?(count|num|total|n))?$/i, ROLES.VOLUME],
    [/^(aht|avg[\s_-]?handle[\s_-]?time|handle[\s_-]?time|talk[\s_-]?time|act|avg[\s_-]?call[\s_-]?time)([\s_-]?(sec|secs|seconds|min|mins|s))?$/i, ROLES.AHT],
    [/^(sl|sla|service[\s_-]?level|sl[\s_-]?%)([\s_-]?(pct|percent|%|target))?$/i, ROLES.SLA],
    [/^(abandon(ed|ment)?|abnd|aban|aban[\s_-]?rate)([\s_-]?(rate|pct|%))?$/i, ROLES.ABANDON],
    [/^(handled|answered|hndl|hnd)([\s_-]?(count|n))?$/i, ROLES.HANDLED],
    [/^(occ|occupancy)([\s_-]?(pct|%|target))?$/i,         ROLES.OCCUPANCY],
    [/^(shrinkage|shrink)([\s_-]?(pct|%|target))?$/i,      ROLES.SHRINKAGE]
  ];

  /* ====================================================
   * PUBLIC API
   * ==================================================== */
  Detector.detect = function (parsed) {
    const { headers, rows } = parsed;
    if (!headers || headers.length === 0 || rows.length === 0) {
      return blank();
    }

    const assumptions = [];

    // 1. Per-column descriptive stats
    const columns = headers.map((name, i) => describeColumn(name, i, rows));

    // 2. Classify each column by combined header + value heuristics
    columns.forEach(c => classifyColumn(c));

    // 3. Check whether headers themselves are time-series buckets (wide format)
    const headerTime = detectTimeSeriesHeaders(headers, columns);
    if (headerTime.isTimeSeries) {
      // Mark those columns as TIME_BUCKET (override numeric classification)
      headerTime.columnIndices.forEach(idx => {
        columns[idx].role = ROLES.TIME_BUCKET;
        columns[idx].confidence = Math.max(columns[idx].confidence, 0.9);
        columns[idx].timeMeta = headerTime.perColumn[idx];
      });
      assumptions.push(`Detected ${headerTime.columnIndices.length} time-bucket columns (${headerTime.pattern}): ${headerTime.sequence.slice(0,3).join(', ')}${headerTime.sequence.length>3?'…':''}`);
    }

    // 4. Detect Total / aggregation column
    const totalColumnIndex = detectTotalColumn(columns, rows, headerTime);
    if (totalColumnIndex != null) {
      columns[totalColumnIndex].role = ROLES.TOTAL;
      assumptions.push(`Detected aggregate column "${columns[totalColumnIndex].name}" — will be excluded from time series`);
    }

    // 5. Determine overall format
    const format = decideFormat(columns, headerTime);

    // 6. Identify the queue-axis column (where queue identity lives)
    const queueAxis = pickQueueAxis(columns);

    // 7. Identify value columns (in long format: the volume col; in wide: every time-bucket col)
    const valueColumns = format.format === 'wide'
      ? headerTime.columnIndices.slice()
      : columns.filter(c => c.role === ROLES.VOLUME).map(c => c.index);

    // 8. Time axis
    const timeAxis = format.format === 'wide'
      ? {
          kind: 'header',
          headerColumns: headerTime.columnIndices,
          pattern: headerTime.pattern,
          sequence: headerTime.sequence,
          inferredDates: inferDatesForBuckets(headerTime)
        }
      : {
          kind: 'column',
          columnIndex: columns.find(c => c.role === ROLES.DATE)?.index ?? null,
          pattern: 'date'
        };

    // 9. Build ambiguities → user-facing structured questions
    const ambiguities = buildAmbiguities({ columns, totalColumnIndex, headerTime, format, queueAxis, valueColumns });

    return {
      format: format.format,
      formatConfidence: format.confidence,
      columns,
      timeAxis,
      queueAxis,
      valueColumns,
      totalColumnIndex,
      ambiguities,
      assumptions
    };
  };

  /* ====================================================
   * COLUMN-LEVEL CLASSIFICATION
   * ==================================================== */
  function describeColumn(name, index, rows) {
    const values = rows.map(r => r[index]);
    const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined).length;
    const unique = new Set(values).size;
    const sample = values.slice(0, 8);
    const numericValues = values.map(toNum).filter(v => v != null);

    let stats = null;
    if (numericValues.length > 0) {
      const sum  = numericValues.reduce((s,v)=>s+v, 0);
      const mean = sum / numericValues.length;
      const sorted = [...numericValues].sort((a,b)=>a-b);
      const min = sorted[0], max = sorted[sorted.length-1];
      const median = sorted[Math.floor(sorted.length/2)];
      stats = {
        n: numericValues.length, sum, mean, min, max, median,
        fractionNumeric: numericValues.length / values.length,
        isInteger: numericValues.every(v => Number.isInteger(v))
      };
    }

    return { index, name, sample, nonEmpty, unique, total: values.length, stats, role: ROLES.UNKNOWN, confidence: 0 };
  }

  function classifyColumn(col) {
    // 1. Header hint takes priority when strong
    for (const [rx, role] of HEADER_HINTS) {
      if (rx.test(col.name)) { col.role = role; col.confidence = 0.95; return; }
    }
    // 2. Pure-text low-cardinality columns
    if (col.stats == null) {
      // Strings only
      if (col.unique <= 12 && col.unique > 1 && col.unique / col.total < 0.4) {
        const sampleLower = col.sample.map(s => String(s).toLowerCase());
        const channels = ['voice','call','phone','chat','email','sms','social','case','async','backoffice'];
        if (sampleLower.some(s => channels.includes(s))) { col.role = ROLES.CHANNEL; col.confidence = 0.85; return; }
        col.role = ROLES.QUEUE; col.confidence = 0.55; return;
      }
      // Mostly unique → could be agent IDs / free text
      if (col.unique / col.total > 0.7) { col.role = ROLES.AGENT; col.confidence = 0.4; return; }
      col.role = ROLES.UNKNOWN; col.confidence = 0.1; return;
    }
    // 3. Numeric. Use range as a fingerprint.
    const s = col.stats;
    // SL%: bounded 0-1 or 0-100, no negatives
    if (s.min >= 0 && (s.max <= 1.01 || (s.max <= 100.01 && s.mean > 1)) && s.fractionNumeric > 0.9 && !s.isInteger) {
      col.role = ROLES.SLA; col.confidence = 0.65; return;
    }
    // AHT: typically 30..3600s, integer-ish
    if (s.min >= 10 && s.max <= 7200 && s.mean > 50 && s.mean < 1500) {
      col.role = ROLES.AHT; col.confidence = 0.6; return;
    }
    // Volume: integer-ish, broad range
    if (s.isInteger && s.min >= 0 && s.max > 5) {
      col.role = ROLES.VOLUME; col.confidence = 0.55; return;
    }
    col.role = ROLES.UNKNOWN; col.confidence = 0.2;
  }

  /* ====================================================
   * TIME-SERIES HEADER DETECTION (wide-format trigger)
   * ==================================================== */
  function detectTimeSeriesHeaders(headers, columns) {
    const perColumn = {};
    const matches = [];

    for (let i = 0; i < headers.length; i++) {
      const h = (headers[i] || '').trim();
      if (!h) continue;
      // Skip if column is clearly textual (queue/channel/etc.) — but allow if column is numeric
      if (columns[i].stats == null || columns[i].stats.fractionNumeric < 0.5) continue;
      if (TOTAL_RX.test(h) || AVG_RX.test(h)) continue;

      for (const p of HEADER_PATTERNS) {
        const m = h.match(p.rx);
        if (m) {
          const idx = p.toIndex(m);
          perColumn[i] = { kind: p.kind, raw: h, ordinal: idx };
          matches.push({ index: i, kind: p.kind, raw: h, ordinal: idx });
          break;
        }
      }
    }

    if (matches.length < 2) return { isTimeSeries: false };

    // All matches should belong to the same kind for a clean wide layout
    const kinds = new Set(matches.map(m => m.kind));
    if (kinds.size > 1) {
      // Mixed kinds (e.g. some Week and some Q) — keep the dominant
      const counts = {};
      matches.forEach(m => counts[m.kind] = (counts[m.kind] || 0) + 1);
      const winner = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
      const filtered = matches.filter(m => m.kind === winner);
      if (filtered.length < 2) return { isTimeSeries: false };
      matches.length = 0; matches.push(...filtered);
    }

    matches.sort((a,b) => a.ordinal - b.ordinal);
    const pattern = matches[0].kind;
    const sequence = matches.map(m => m.raw);
    const columnIndices = matches.map(m => m.index);

    return { isTimeSeries: true, pattern, sequence, columnIndices, perColumn };
  }

  function inferDatesForBuckets(headerTime) {
    if (!headerTime.isTimeSeries) return [];
    const n = headerTime.sequence.length;
    const today = new Date();
    // Reference: the LAST bucket lands on the most recent complete unit ending before today.
    const out = [];

    if (headerTime.pattern === 'weekly') {
      // Anchor: Monday of the ISO week that ended most recently
      const ref = mostRecentMonday(today);
      for (let i = 0; i < n; i++) {
        const d = new Date(ref);
        d.setUTCDate(d.getUTCDate() - (n - 1 - i) * 7);
        out.push(d.toISOString().slice(0,10));
      }
    } else if (headerTime.pattern === 'daily') {
      for (let i = 0; i < n; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - (n - 1 - i));
        out.push(d.toISOString().slice(0,10));
      }
    } else if (headerTime.pattern === 'monthly' || headerTime.pattern === 'monthName') {
      for (let i = 0; i < n; i++) {
        const d = new Date(today.getUTCFullYear(), today.getUTCMonth() - (n - 1 - i), 1);
        out.push(d.toISOString().slice(0,10));
      }
    } else if (headerTime.pattern === 'iso_date' || headerTime.pattern === 'us_date') {
      out.push(...headerTime.sequence.map((label, i) => {
        const utc = headerTime.perColumn[headerTime.columnIndices[i]].ordinal;
        return new Date(utc).toISOString().slice(0,10);
      }));
    } else {
      // Quarterly / unknown — fall back to sequential dates spaced by 7 days
      for (let i = 0; i < n; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - (n - 1 - i) * 7);
        out.push(d.toISOString().slice(0,10));
      }
    }
    return out;
  }

  function mostRecentMonday(d) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = x.getUTCDay() || 7;     // Sunday→7
    x.setUTCDate(x.getUTCDate() - (day - 1));
    return x;
  }

  /* ====================================================
   * TOTAL-COLUMN DETECTION
   * ==================================================== */
  function detectTotalColumn(columns, rows, headerTime) {
    // 1. Name-based: column called Total / Sum / Grand Total
    for (const c of columns) {
      if (TOTAL_RX.test(c.name) && c.stats != null) return c.index;
    }
    // 2. Value-based: the last numeric column whose row values ~= sum of time-bucket cells
    if (headerTime.isTimeSeries && headerTime.columnIndices.length >= 2) {
      const lastTimeCol = headerTime.columnIndices[headerTime.columnIndices.length - 1];
      for (let i = lastTimeCol + 1; i < columns.length; i++) {
        const c = columns[i];
        if (!c.stats) continue;
        const matches = rows.filter(r => {
          const cellSum = headerTime.columnIndices.reduce((s, ci) => s + (toNum(r[ci]) || 0), 0);
          const v = toNum(r[c.index]);
          if (v == null || cellSum === 0) return false;
          return Math.abs(v - cellSum) / Math.max(1, cellSum) < 0.02;     // 2% tolerance
        }).length;
        if (matches / Math.max(1, rows.length) >= 0.7) return c.index;
      }
    }
    return null;
  }

  /* ====================================================
   * FORMAT DECISION
   * ==================================================== */
  function decideFormat(columns, headerTime) {
    const hasDateCol = columns.some(c => c.role === ROLES.DATE);
    const hasVolumeCol = columns.some(c => c.role === ROLES.VOLUME);
    const hasTimeHeaders = headerTime.isTimeSeries;

    // Wide: time buckets in headers, plus at least one queue/skill string column
    const hasQueueCol = columns.some(c => c.role === ROLES.QUEUE);

    if (hasTimeHeaders && !hasDateCol) {
      return { format: 'wide', confidence: hasQueueCol ? 0.95 : 0.75 };
    }
    if (hasDateCol && hasVolumeCol) {
      return { format: 'long', confidence: 0.95 };
    }
    if (hasTimeHeaders && hasDateCol) {
      return { format: 'mixed', confidence: 0.6 };
    }
    if (hasVolumeCol && !hasDateCol && !hasTimeHeaders) {
      return { format: 'long', confidence: 0.5 };   // missing date but otherwise long-ish
    }
    return { format: 'unknown', confidence: 0.3 };
  }

  /* ====================================================
   * QUEUE-AXIS PICK
   * ==================================================== */
  function pickQueueAxis(columns) {
    const queueCols = columns.filter(c => c.role === ROLES.QUEUE);
    if (queueCols.length === 1) return { kind: 'column', columnIndex: queueCols[0].index };
    if (queueCols.length > 1) {
      // Prefer the lowest-cardinality one (more likely the true queue, not a sub-skill)
      queueCols.sort((a,b) => a.unique - b.unique);
      return { kind: 'column', columnIndex: queueCols[0].index, ambiguous: true };
    }
    return { kind: 'none' };
  }

  /* ====================================================
   * AMBIGUITIES → user questions
   * ==================================================== */
  function buildAmbiguities({ columns, totalColumnIndex, headerTime, format, queueAxis, valueColumns }) {
    const out = [];

    if (totalColumnIndex != null) {
      out.push({
        id: 'confirm_total',
        q: `We detected "${columns[totalColumnIndex].name}" as an aggregate column. Exclude it from the time series?`,
        opts: ['Yes, exclude', 'No, treat as a regular bucket'],
        default: 'Yes, exclude'
      });
    }

    if (format.format === 'wide' && headerTime.isTimeSeries && headerTime.pattern === 'weekly') {
      out.push({
        id: 'week_anchor',
        q: `Are these ${headerTime.sequence.length} weeks meant to be sequential, with Week ${headerTime.sequence.length} being the most recent?`,
        opts: ['Yes, sequential ending this week', 'Yes, sequential ending a different week', 'No — they are not sequential'],
        default: 'Yes, sequential ending this week'
      });
    }

    if (queueAxis.ambiguous) {
      out.push({
        id: 'queue_axis_pick',
        q: `Multiple columns look queue-like. Which one identifies the queue?`,
        opts: columns.filter(c => c.role === Detector.ROLES.QUEUE).map(c => c.name),
        default: columns[queueAxis.columnIndex].name
      });
    }

    if (format.format === 'unknown') {
      out.push({
        id: 'manual_schema',
        q: `We could not confidently identify the structure. Tell us what each column represents?`,
        opts: ['Walk me through it', 'I will reformat the file and retry'],
        default: 'Walk me through it'
      });
    }

    return out;
  }

  /* ---------- Helpers ---------- */
  function toNum(v) {
    if (v == null || v === '') return null;
    const s = String(v).replace(/[,%$\s]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function blank() {
    return { format: 'unknown', formatConfidence: 0, columns: [], timeAxis: { kind: 'none' }, queueAxis: { kind: 'none' }, valueColumns: [], totalColumnIndex: null, ambiguities: [], assumptions: ['Empty input'] };
  }

  WFM.CSV = WFM.CSV || {};
  WFM.CSV.Detector = Detector;
})(window.WFM = window.WFM || {});
