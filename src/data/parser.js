/* =========================================================
 * Data Pipeline: PARSER
 * Pure text → rows + headers. No interpretation, no inference.
 *
 * Responsibilities:
 *   - Sniff delimiter (, vs ; vs \t vs |)
 *   - Handle quoted fields with embedded commas / newlines
 *   - Strip BOM, normalize line endings
 *   - Skip blank lines and lines that are only delimiters
 *   - Detect and isolate the header row
 *
 * Output shape:
 *   { headers, rows, meta: { delimiter, originalRowCount, skippedEmpty } }
 *
 * Anything that needs to "understand" the data lives in detector.js
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Parser = {};

  /* ---------- Public ---------- */
  Parser.parse = function (text, opts) {
    opts = opts || {};
    if (typeof text !== 'string') throw new Error('Parser.parse: expected string input');

    // 1. Normalize line endings, strip BOM
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

    // 2. Sniff delimiter from first non-empty line, unless caller provided one
    const delim = opts.delimiter || sniffDelimiter(text);

    // 3. Tokenize (RFC-4180-ish, supports quoted fields with embedded delimiter/newline)
    const allRows = tokenize(text, delim);

    // 4. Filter blank rows (all cells empty)
    const nonEmpty = allRows.filter(r => r.some(c => String(c).trim() !== ''));
    const skippedEmpty = allRows.length - nonEmpty.length;

    if (nonEmpty.length === 0) {
      return { headers: [], rows: [], meta: { delimiter: delim, originalRowCount: 0, skippedEmpty } };
    }

    // 5. Header row = first non-empty (we don't second-guess yet; the detector decides
    //    if the apparent header is actually data and corrects)
    const headers = nonEmpty[0].map(h => String(h || '').trim());
    const dataRows = nonEmpty.slice(1).map(r => {
      // Pad short rows; truncate over-long rows
      const out = new Array(headers.length).fill('');
      for (let i = 0; i < Math.min(r.length, headers.length); i++) {
        out[i] = typeof r[i] === 'string' ? r[i].trim() : r[i];
      }
      return out;
    });

    return {
      headers,
      rows: dataRows,
      meta: {
        delimiter: delim,
        delimiterName: ({',':'comma','\t':'tab',';':'semicolon','|':'pipe'})[delim] || 'unknown',
        originalRowCount: allRows.length,
        skippedEmpty
      }
    };
  };

  /* ---------- Delimiter sniff ----------
   * Score each candidate by:
   *   - Whether it appears in the first line
   *   - Whether row-by-row token counts are stable (low variance)
   * The stable one wins. Default: comma.
   */
  function sniffDelimiter(text) {
    const sampleLines = text.split('\n').filter(l => l.trim()).slice(0, 8);
    if (!sampleLines.length) return ',';

    const candidates = [',', '\t', ';', '|'];
    let best = ',', bestScore = -Infinity;

    for (const c of candidates) {
      const counts = sampleLines.map(l => (l.match(new RegExp(escapeRe(c), 'g')) || []).length);
      const mean = counts.reduce((s,v)=>s+v,0) / counts.length;
      if (mean < 1) continue;                          // delimiter not present
      const variance = counts.reduce((s,v)=>s + (v-mean)*(v-mean), 0) / counts.length;
      const stability = 1 / (1 + variance);            // higher = more stable
      const score = mean * stability;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /* ---------- Tokenizer ----------
   * State machine: handles "quoted, fields", embedded "" quotes,
   * delimiters inside quotes, and quoted fields spanning newlines.
   */
  function tokenize(text, delim) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i+1] === '"') { field += '"'; i++; }  // escaped quote
          else inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"' && field === '') {
          inQuotes = true;
        } else if (ch === delim) {
          row.push(field); field = '';
        } else if (ch === '\n') {
          row.push(field); rows.push(row); row = []; field = '';
        } else {
          field += ch;
        }
      }
    }
    // Flush last cell / row
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  WFM.CSV = WFM.CSV || {};
  WFM.CSV.Parser = Parser;
})(window.WFM = window.WFM || {});
