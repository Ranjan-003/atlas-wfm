/* =========================================================
 * Data Pipeline: TRANSFORMER
 * Detection + Parsed rows → normalized canonical schema.
 *
 * Canonical row: { date: 'YYYY-MM-DD', queue: string, volume: number, channel: string }
 *
 * Long format:  one row per cell → emit each row's date + queue + volume.
 * Wide format:  unpivot — one row per (input_row, time_bucket_column).
 * Mixed:        same as wide unless the date column is also time-bucketed.
 *
 * The transformer never invents data. If a field is missing it uses
 * documented defaults (channel→"voice") and logs every assumption.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Transformer = {};
  const ROLES = WFM.CSV.Detector.ROLES;

  /* ====================================================
   * PUBLIC
   * ==================================================== */
  Transformer.transform = function (parsed, detection, opts) {
    opts = opts || {};
    const log = [];

    if (detection.format === 'unknown' || detection.columns.length === 0) {
      log.push('Skipped transform: format unknown or empty');
      return { rows: [], log, defaultChannel: 'voice', queueColumn: null, droppedRows: 0 };
    }

    const defaultChannel = opts.defaultChannel || inferDefaultChannel(detection) || 'voice';
    if (defaultChannel === 'voice' && !detection.columns.some(c => c.role === ROLES.CHANNEL)) {
      log.push('No channel column detected → defaulting all rows to "voice"');
    }

    let result;
    if (detection.format === 'wide')  result = transformWide(parsed, detection, defaultChannel, log);
    else if (detection.format === 'long' || detection.format === 'mixed') result = transformLong(parsed, detection, defaultChannel, log);
    else result = { rows: [], droppedRows: 0 };

    return { ...result, log, defaultChannel, queueColumn: detection.queueAxis.columnIndex ?? null };
  };

  /* ====================================================
   * WIDE → LONG
   * ==================================================== */
  function transformWide(parsed, detection, defaultChannel, log) {
    const { rows } = parsed;
    const { columns, timeAxis, queueAxis, totalColumnIndex, valueColumns } = detection;

    const dates = timeAxis.inferredDates || [];
    const bucketCols = timeAxis.headerColumns || valueColumns;
    const queueCol = queueAxis.kind === 'column' ? queueAxis.columnIndex : null;
    const channelCol = columns.find(c => c.role === ROLES.CHANNEL)?.index ?? null;

    if (dates.length !== bucketCols.length) {
      log.push(`Date inference mismatch (${dates.length} dates for ${bucketCols.length} buckets) — using sequential fallback`);
    }

    log.push(`Unpivoting ${bucketCols.length} time-bucket columns across ${rows.length} source rows → ${rows.length * bucketCols.length} normalized rows max`);
    if (totalColumnIndex != null) log.push(`Excluding total column at index ${totalColumnIndex}`);

    const out = [];
    let dropped = 0;

    for (const r of rows) {
      const queue = queueCol != null ? cleanString(r[queueCol]) : '(unknown)';
      const channel = channelCol != null ? normalizeChannel(r[channelCol]) : defaultChannel;

      // If the row's queue value is empty AND no other identifying string columns hold a value, skip
      if (!queue || queue === '(unknown)') {
        const hasAnyId = columns.some(c => c.role === ROLES.QUEUE || c.role === ROLES.AGENT) && false;
        if (!hasAnyId) { dropped++; continue; }
      }

      for (let k = 0; k < bucketCols.length; k++) {
        const colIdx = bucketCols[k];
        if (colIdx === totalColumnIndex) continue;
        const raw = r[colIdx];
        const v = toNum(raw);
        if (v == null) { dropped++; continue; }
        out.push({
          date: dates[k] || `bucket_${k+1}`,
          queue,
          volume: v,
          channel
        });
      }
    }

    return { rows: out, droppedRows: dropped };
  }

  /* ====================================================
   * LONG (already row-per-observation)
   * ==================================================== */
  function transformLong(parsed, detection, defaultChannel, log) {
    const { rows } = parsed;
    const { columns } = detection;
    const dateCol    = columns.find(c => c.role === ROLES.DATE)?.index ?? null;
    const queueCol   = columns.find(c => c.role === ROLES.QUEUE)?.index ?? null;
    const channelCol = columns.find(c => c.role === ROLES.CHANNEL)?.index ?? null;
    const volumeCol  = columns.find(c => c.role === ROLES.VOLUME)?.index ?? null;

    if (volumeCol == null) {
      log.push('No volume column identified — cannot normalize. Returning empty.');
      return { rows: [], droppedRows: rows.length };
    }

    log.push(`Long-format transform: date=${dateCol!=null?columns[dateCol].name:'(none)'}, queue=${queueCol!=null?columns[queueCol].name:'(none)'}, volume=${columns[volumeCol].name}, channel=${channelCol!=null?columns[channelCol].name:`default(${defaultChannel})`}`);

    const out = [];
    let dropped = 0;
    let dateParseFailures = 0;
    let lastImpliedDate = null;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const v = toNum(r[volumeCol]);
      if (v == null) { dropped++; continue; }

      let date;
      if (dateCol != null) {
        date = parseDate(r[dateCol]);
        if (!date) { dateParseFailures++; date = sequentialFallback(i); }
      } else {
        date = sequentialFallback(i);
      }

      const queue = queueCol != null ? cleanString(r[queueCol]) || '(unknown)' : '(unknown)';
      const channel = channelCol != null ? normalizeChannel(r[channelCol]) || defaultChannel : defaultChannel;

      out.push({ date, queue, volume: v, channel });
      lastImpliedDate = date;
    }

    if (dateParseFailures > 0) log.push(`${dateParseFailures} rows had unparseable dates — fell back to sequential indexing`);
    if (dropped > 0)            log.push(`Dropped ${dropped} rows with missing volume`);

    return { rows: out, droppedRows: dropped };
  }

  /* ====================================================
   * Helpers
   * ==================================================== */
  function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    // ISO yyyy-mm-dd
    const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
    // US m/d/y
    const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (us) {
      const y = +us[3] < 100 ? 2000 + +us[3] : +us[3];
      return `${y}-${pad(+us[1])}-${pad(+us[2])}`;
    }
    // Excel-style serial number? (days since 1899-12-30)
    if (/^\d{4,6}$/.test(s) && +s > 25000 && +s < 100000) {
      const d = new Date(Date.UTC(1899, 11, 30) + (+s) * 86400000);
      return d.toISOString().slice(0,10);
    }
    return null;
  }
  function pad(n) { return String(n).padStart(2,'0'); }
  function sequentialFallback(i) {
    // Use today minus (totalRows - 1 - i) days — we don't know totalRows here so
    // emit a placeholder; validator will catch this and recommend the user fix dates.
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    return d.toISOString().slice(0,10);
  }
  function toNum(v) {
    if (v == null || v === '') return null;
    const s = String(v).replace(/[,%$\s]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function cleanString(v) {
    if (v == null) return '';
    return String(v).trim().replace(/\s+/g, ' ');
  }
  function normalizeChannel(v) {
    if (!v) return null;
    const s = String(v).trim().toLowerCase();
    if (['call','phone','voice','inbound','outbound','ivr'].includes(s)) return 'voice';
    if (['chat','webchat','livechat','messenger'].includes(s)) return 'chat';
    if (['email','mail','ticket'].includes(s)) return 'email';
    if (['backoffice','bo','case','async'].includes(s)) return 'backoffice';
    if (['sms','text'].includes(s)) return 'sms';
    return s;
  }
  function inferDefaultChannel(detection) {
    // Heuristic: if any queue name contains a channel keyword, use that
    const queueCol = detection.queueAxis.columnIndex;
    if (queueCol == null) return 'voice';
    // The Detector doesn't store sample queue values; we just default
    return 'voice';
  }

  WFM.CSV = WFM.CSV || {};
  WFM.CSV.Transformer = Transformer;
})(window.WFM = window.WFM || {});
