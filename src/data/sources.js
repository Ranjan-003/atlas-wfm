/* =========================================================
 * Data Sources — "Get Data" connector framework
 *
 * Architecture
 * ------------
 * A DataSource is a saved connection. Each source has a `kind` that
 * determines how it gets rows:
 *
 *   - csv_upload    : user uploads CSV / TSV. One-time + replayable.
 *   - excel_paste   : user pastes a tab-separated block from Excel.
 *   - sql_paste     : user runs a SELECT in their DB tool, pastes results here.
 *   - json_api      : declarative HTTP fetch with field path mapping.
 *
 * All connectors return rows in the same canonical shape after column
 * mapping: { date, queue, volume, channel }.
 *
 * Column mapping is the key abstraction — the user declares which
 * source column maps to which canonical field. This means a SQL query
 * like SELECT call_date, skill, n_calls FROM stats can become canonical
 * by mapping (call_date→date, skill→queue, n_calls→volume).
 *
 * Why "paste" rather than direct DB connect? A browser cannot dial a
 * SQL server. Production would route through a backend. The paste
 * pattern matches how power users currently move data from SSMS,
 * pgAdmin, or DBeaver into Excel. The contract is the same once you
 * have the rows.
 *
 * Public API:
 *   WFM.DataSources.list()
 *   WFM.DataSources.get(id)
 *   WFM.DataSources.save(source)
 *   WFM.DataSources.delete(id)
 *   WFM.DataSources.fetch(source) → Promise<{rows, schema, mapping}>
 *   WFM.DataSources.normalize(rows, mapping, defaults) → canonical rows
 * ========================================================= */
(function (WFM) {
  'use strict';
  const STORAGE_KEY = 'atlas-data-sources';

  /* ====================================================
   * Source kinds — metadata for the UI
   * ==================================================== */
  const KINDS = {
    csv_upload: {
      label: 'CSV / TSV File',
      icon: 'upload',
      description: 'Upload a file from your computer. Reuses the intelligent ingestion pipeline.',
      requires: ['file content']
    },
    excel_paste: {
      label: 'Excel / Sheets paste',
      icon: 'data',
      description: 'Copy a range from Excel or Google Sheets and paste here. Tab-separated values are auto-detected.',
      requires: ['pasted text']
    },
    sql_paste: {
      label: 'SQL query result',
      icon: 'data',
      description: 'Run a SELECT query in your database tool (SSMS, pgAdmin, DBeaver) and paste the results here. Browser apps cannot connect to databases directly.',
      requires: ['SQL query (for reference)', 'pasted result rows']
    },
    json_api: {
      label: 'JSON API endpoint',
      icon: 'data',
      description: 'Fetch from a REST endpoint that returns JSON. CORS rules apply — many enterprise APIs need a backend proxy.',
      requires: ['URL', 'optional headers', 'JSON path to row array']
    }
  };

  /* ====================================================
   * State + persistence
   * ==================================================== */
  let sources = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {}
    return [];
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sources)); } catch (_) {}
  }

  /* ====================================================
   * Canonical field set
   * ==================================================== */
  const CANONICAL_FIELDS = [
    { key: 'date',    label: 'Date',        required: true,  description: 'A date or week label per row' },
    { key: 'queue',   label: 'Queue',       required: true,  description: 'Queue / skill / line identifier' },
    { key: 'volume',  label: 'Volume',      required: true,  description: 'Number of contacts / cases' },
    { key: 'channel', label: 'Channel',     required: false, description: 'voice / chat / email / web — defaults to voice if missing' }
  ];

  /* ====================================================
   * Public API
   * ==================================================== */
  const DS = {};

  DS.KINDS = KINDS;
  DS.CANONICAL_FIELDS = CANONICAL_FIELDS;

  DS.list = () => sources.slice();
  DS.get  = id => sources.find(s => s.id === id);

  DS.save = function (source) {
    if (!source.id) source.id = 'src_' + Date.now().toString(36);
    source.updatedAt = new Date().toISOString();
    const i = sources.findIndex(s => s.id === source.id);
    if (i >= 0) sources[i] = source;
    else sources.push(source);
    save();
    return source.id;
  };

  DS.delete = function (id) {
    sources = sources.filter(s => s.id !== id);
    save();
  };

  /* ====================================================
   * fetch(source) — runs the source, returns parsed rows + schema
   * Returns a promise so the UI can show a loading state.
   * ==================================================== */
  DS.fetch = function (source) {
    return new Promise((resolve, reject) => {
      try {
        let text = '';
        if (source.kind === 'csv_upload' || source.kind === 'excel_paste') {
          text = source.payload || '';
          if (!text) return reject(new Error('No content provided.'));
          // Excel paste is typically TSV; ingest already sniffs delimiter
          const ingest = WFM.CSV.ingest(text);
          return resolve({
            rows: ingest.cleanedData,
            schema: ingest.detectedSchema,
            issues: ingest.issues,
            confidence: ingest.confidence,
            log: ingest.log,
            // Raw rows for column-mapping UI
            rawHeaders: ingest.detectedSchema.columns.map(c => c.name),
            rawSample: extractSample(ingest.detectedSchema)
          });
        }

        if (source.kind === 'sql_paste') {
          text = source.payload || '';
          if (!text) return reject(new Error('Paste a result set first.'));
          const ingest = WFM.CSV.ingest(text);
          return resolve({
            rows: ingest.cleanedData,
            schema: ingest.detectedSchema,
            issues: ingest.issues,
            confidence: ingest.confidence,
            log: ingest.log,
            sql: source.sql || '',
            rawHeaders: ingest.detectedSchema.columns.map(c => c.name),
            rawSample: extractSample(ingest.detectedSchema)
          });
        }

        if (source.kind === 'json_api') {
          if (!source.url) return reject(new Error('No URL provided.'));
          fetch(source.url, {
            headers: source.headers || {},
            credentials: 'omit'
          }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(json => {
              const rows = navigatePath(json, source.jsonPath || '');
              if (!Array.isArray(rows)) throw new Error('JSON path did not resolve to an array');
              // Synthesize a CSV-like header row so we can reuse mapping UI
              const headers = rows.length ? Object.keys(rows[0]) : [];
              const sample = rows.slice(0, 5);
              resolve({
                rows,
                rawHeaders: headers,
                rawSample: sample,
                schema: null,
                confidence: rows.length > 10 ? 'High' : 'Medium',
                log: [{ stage: 'fetch', detail: `${rows.length} rows from ${source.url}` }]
              });
            })
            .catch(reject);
          return;
        }

        reject(new Error('Unknown source kind: ' + source.kind));
      } catch (err) {
        reject(err);
      }
    });
  };

  /* ====================================================
   * normalize(rows, mapping, defaults)
   * Apply a column-mapping to raw rows → canonical { date, queue, volume, channel }
   * mapping shape: { date: 'colName', queue: 'colName', volume: 'colName', channel: 'colName' | null }
   * ==================================================== */
  DS.normalize = function (rows, mapping, defaults) {
    defaults = defaults || { channel: 'voice', queue: 'Unnamed Queue' };
    if (!Array.isArray(rows) || !mapping) return [];

    const out = [];
    for (const r of rows) {
      // For ingested rows from CSV.ingest, fields are already canonical; mapping then is a no-op identity
      const isAlreadyCanonical = (typeof r === 'object' && 'date' in r && 'queue' in r && 'volume' in r);
      const row = isAlreadyCanonical ? r : {
        date:    mapping.date    ? r[mapping.date]    : null,
        queue:   mapping.queue   ? r[mapping.queue]   : defaults.queue,
        volume:  mapping.volume  ? r[mapping.volume]  : null,
        channel: mapping.channel ? r[mapping.channel] : defaults.channel
      };
      const vol = toNum(row.volume);
      if (vol == null) continue;
      out.push({
        date: row.date != null ? String(row.date) : null,
        queue: row.queue != null && String(row.queue).trim() !== '' ? String(row.queue).trim() : defaults.queue,
        volume: vol,
        channel: normalizeChannel(row.channel) || defaults.channel
      });
    }
    return out;
  };

  /* ====================================================
   * Helpers
   * ==================================================== */
  function extractSample(schema) {
    if (!schema || !schema.columns) return [];
    const rows = [];
    const n = Math.min(5, (schema.columns[0]?.sample || []).length);
    for (let i = 0; i < n; i++) {
      const row = {};
      schema.columns.forEach(c => row[c.name] = c.sample[i]);
      rows.push(row);
    }
    return rows;
  }
  function navigatePath(obj, path) {
    if (!path) return obj;
    return path.split('.').reduce((acc, p) => acc?.[p], obj);
  }
  function toNum(v) {
    if (v == null || v === '') return null;
    const s = String(v).replace(/[,%$\s]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function normalizeChannel(v) {
    if (!v) return null;
    const s = String(v).trim().toLowerCase();
    if (['call','phone','voice','inbound','outbound','ivr'].includes(s)) return 'voice';
    if (['chat','webchat','livechat','messenger'].includes(s)) return 'chat';
    if (['email','mail','ticket'].includes(s)) return 'email';
    if (['web','case','web case','webcase','async'].includes(s)) return 'web';
    return s;
  }

  WFM.DataSources = DS;
})(window.WFM = window.WFM || {});
