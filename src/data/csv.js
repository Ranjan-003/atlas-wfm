/* =========================================================
 * CSV — Orchestrator
 *
 * Pipeline:
 *   Parser → Detector → Transformer → Validator
 *     ↓        ↓           ↓             ↓
 *  raw text  schema    canonical rows  issues
 *
 *                  ↓
 *           Confidence scorer
 *                  ↓
 *           Full structured output
 *
 * Public API:
 *   WFM.CSV.ingest(text)       → full pipeline output (NEW, preferred)
 *   WFM.CSV.parse(text)        → legacy: { headers, rows }
 *   WFM.CSV.qualityReport(p)   → legacy: per-column report
 * ========================================================= */
(function (WFM) {
  'use strict';
  const CSV = WFM.CSV || {};
  const { Parser, Detector, Transformer, Validator } = CSV;

  /* ====================================================
   * NEW PIPELINE — single entry point
   * ==================================================== */
  CSV.ingest = function (text, opts) {
    opts = opts || {};
    const log = [];
    const start = Date.now();

    // Stage 1: parse
    const parsed = Parser.parse(text, opts);
    log.push({ stage: 'parse', detail: `Detected delimiter: ${parsed.meta.delimiterName} · ${parsed.headers.length} columns · ${parsed.rows.length} data rows · ${parsed.meta.skippedEmpty} empty rows skipped` });

    if (parsed.headers.length === 0) {
      return finalize({
        cleanedData: [],
        detectedSchema: emptySchema(),
        issues: [{ severity: 'critical', type: 'empty_input', message: 'No data found in input.' }],
        questions: [],
        confidence: 'Low',
        log
      }, start);
    }

    // Stage 2: detect
    const detection = Detector.detect(parsed);
    log.push({ stage: 'detect', detail: `Format: ${detection.format} (confidence ${(detection.formatConfidence*100).toFixed(0)}%) · ${detection.columns.filter(c => c.role !== 'unknown').length}/${detection.columns.length} columns identified` });
    detection.assumptions.forEach(a => log.push({ stage: 'detect', detail: a }));

    // Stage 3: transform
    const transformed = Transformer.transform(parsed, detection, opts);
    transformed.log.forEach(d => log.push({ stage: 'transform', detail: d }));
    if (transformed.droppedRows > 0) log.push({ stage: 'transform', detail: `Dropped ${transformed.droppedRows} rows during normalization` });
    log.push({ stage: 'transform', detail: `Produced ${transformed.rows.length} canonical row${transformed.rows.length!==1?'s':''} of {date, queue, volume, channel}` });

    // Stage 4: validate
    const validation = Validator.run(transformed.rows);
    log.push({ stage: 'validate', detail: `${validation.issues.length} issue${validation.issues.length!==1?'s':''} flagged (${validation.summary.criticalCount} critical, ${validation.summary.warningCount} warnings)` });

    // Confidence: weighted combination of detection confidence, transform yield, and validator severity
    const confidence = scoreConfidence(detection, transformed, validation, parsed);

    return finalize({
      cleanedData: transformed.rows,
      detectedSchema: {
        format: detection.format,
        formatConfidence: detection.formatConfidence,
        columns: detection.columns.map(c => ({
          index: c.index, name: c.name, role: c.role, confidence: c.confidence,
          nonEmpty: c.nonEmpty, unique: c.unique, sample: c.sample
        })),
        timeAxis: detection.timeAxis,
        queueAxis: detection.queueAxis,
        valueColumns: detection.valueColumns,
        totalColumnIndex: detection.totalColumnIndex,
        defaultChannel: transformed.defaultChannel
      },
      issues: validation.issues,
      questions: detection.ambiguities,
      confidence,
      summary: validation.summary,
      log
    }, start);
  };

  /* ---------- Confidence scoring ---------- */
  function scoreConfidence(detection, transformed, validation, parsed) {
    // Factor 1: how well we recognized the format
    const formatScore = detection.formatConfidence;

    // Factor 2: yield — fraction of input rows that survived normalization
    const expectedRows = parsed.rows.length * Math.max(1, detection.valueColumns.length || 1);
    const yieldScore = expectedRows ? transformed.rows.length / expectedRows : 0;

    // Factor 3: validator severity — critical issues penalize heavily
    const sev = validation.summary.criticalCount * 0.4 + validation.summary.warningCount * 0.05;
    const validationScore = Math.max(0, 1 - sev);

    // Factor 4: column-role coverage — what % of columns got a non-unknown role
    const colKnown = detection.columns.filter(c => c.role !== 'unknown').length;
    const coverageScore = detection.columns.length ? colKnown / detection.columns.length : 0;

    const composite = (formatScore * 0.40) + (yieldScore * 0.30) + (validationScore * 0.20) + (coverageScore * 0.10);
    if (composite >= 0.80) return 'High';
    if (composite >= 0.55) return 'Medium';
    return 'Low';
  }

  function finalize(out, start) {
    out.elapsedMs = Date.now() - start;
    return out;
  }

  function emptySchema() {
    return { format: 'unknown', formatConfidence: 0, columns: [], timeAxis: {kind:'none'}, queueAxis: {kind:'none'}, valueColumns: [], totalColumnIndex: null, defaultChannel: 'voice' };
  }

  /* ====================================================
   * BACKWARD-COMPATIBLE FACADE
   * Older callers (data-studio.js prior to Phase 1) used these.
   * Routes through the new pipeline so behavior stays consistent.
   * ==================================================== */
  CSV.parse = function (text, opts) {
    return Parser.parse(text, opts);
  };

  CSV.qualityReport = function (parsed) {
    // Lift detection over the parsed input and convert to legacy shape
    const detection = Detector.detect(parsed);
    const totalRows = parsed.rows.length;
    const totalCols = parsed.headers.length;
    const issues = [];
    if (detection.columns.filter(c => c.role !== 'unknown').length === 0 && totalRows > 0) {
      issues.push({ severity: 'critical', message: 'Could not classify any columns — please confirm schema manually.' });
    }
    return {
      totalRows,
      totalCols,
      columns: detection.columns,
      issues,
      questions: detection.ambiguities.map(a => ({ q: a.q, opts: a.opts }))
    };
  };

  /* ====================================================
   * Convenience: classify a single column (some tests use this)
   * ==================================================== */
  CSV.classifyColumn = function (name, values) {
    const stub = { index: 0, name, sample: values.slice(0,8), nonEmpty: values.filter(v=>v!=='').length, unique: new Set(values).size, total: values.length, stats: null, role: 'unknown', confidence: 0 };
    const nums = values.map(v => {
      const s = String(v).replace(/[,%$\s]/g,''); const n = parseFloat(s); return isNaN(n) ? null : n;
    }).filter(v => v != null);
    if (nums.length > 0) {
      const sum = nums.reduce((s,v)=>s+v,0);
      stub.stats = { n: nums.length, sum, mean: sum/nums.length, min: Math.min(...nums), max: Math.max(...nums), median: [...nums].sort((a,b)=>a-b)[Math.floor(nums.length/2)], fractionNumeric: nums.length/values.length, isInteger: nums.every(v=>Number.isInteger(v)) };
    }
    // Re-run classifier from detector by calling internal — easier: just re-detect a 1-col table
    const detection = Detector.detect({ headers: [name], rows: values.map(v => [v]) });
    return detection.columns[0];
  };

  WFM.CSV = CSV;
})(window.WFM = window.WFM || {});
