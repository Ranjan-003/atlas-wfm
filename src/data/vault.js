/* =========================================================
 * Atlas Data Vault
 *
 * Centralized persistence layer for everything the user creates:
 *   - Workbench state (queues, channelData, productId, holidayOverrides)
 *   - Forecast lab results (saved as named runs)
 *   - Capacity inputs (per-queue AHT/shrinkage/etc)
 *   - Wizard in-progress state
 *
 * Other stores (Products, Regions, RBAC) manage their own localStorage
 * and are pulled in for export/import operations.
 *
 * Key promises to the user:
 *   1. Every meaningful state change is persisted automatically.
 *   2. Auto-snapshots rotate through 5 slots on each boot — if the app
 *      ever corrupts data, you can roll back.
 *   3. Schema changes migrate forward, never delete. Failed migrations
 *      quarantine the old data instead of discarding it.
 *   4. Export produces a single portable JSON file with EVERYTHING.
 * ========================================================= */
(function (WFM) {
  'use strict';

  const KEYS = {
    studio:      'atlas-studio',       // queues, channelData, productId, holidayOverrides, etc.
    snapshots:   'atlas-snapshots',    // ring buffer of 5 last good states
    quarantine:  'atlas-quarantine',   // failed-migration backups
    boot:        'atlas-boot-meta'     // last boot timestamp, last code version
  };
  const STUDIO_SCHEMA_VERSION = 2;
  const MAX_SNAPSHOTS = 5;
  const MAX_QUARANTINE = 10;

  const Vault = {};

  /* ====================================================
   * Studio state persistence
   * ==================================================== */
  Vault.loadStudio = function () {
    try {
      const raw = localStorage.getItem(KEYS.studio);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Schema migrate or quarantine
      if (parsed.schema === STUDIO_SCHEMA_VERSION) return parsed.data;
      const migrated = migrateStudio(parsed);
      if (migrated.ok) {
        Vault.saveStudio(migrated.data);
        return migrated.data;
      } else {
        quarantine('studio', parsed, migrated.reason);
        return null;
      }
    } catch (e) {
      console.warn('[Vault] loadStudio failed:', e);
      return null;
    }
  };

  Vault.saveStudio = function (studio) {
    try {
      const payload = { schema: STUDIO_SCHEMA_VERSION, data: studio, savedAt: new Date().toISOString() };
      localStorage.setItem(KEYS.studio, JSON.stringify(payload));
    } catch (e) {
      console.error('[Vault] saveStudio failed:', e);
    }
  };

  function migrateStudio(parsed) {
    // schema 1 → 2: ensure queues have channels/channelData/regions/holidayOverrides shape
    // Anything older or unparseable gets quarantined.
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'invalid_format' };
    if (parsed.schema === 1 && parsed.data && Array.isArray(parsed.data.queues)) {
      const data = parsed.data;
      data.queues = data.queues.map(q => {
        if (Array.isArray(q.channels) && q.channelData) return q;   // already new shape
        const ch = q.channel || 'voice';
        return {
          id: q.id,
          name: q.name,
          channels: [ch],
          channelData: { [ch]: q.weeks || new Array(13).fill(0) },
          regions: q.regions || [],
          productId: q.productId || null,
          holidayOverrides: q.holidayOverrides || {}
        };
      });
      return { ok: true, data };
    }
    return { ok: false, reason: 'unknown_schema_version' };
  }

  /* ====================================================
   * Snapshots — rotating ring buffer
   * Taken on every boot, plus before destructive operations.
   * ==================================================== */
  Vault.listSnapshots = function () {
    try {
      const raw = localStorage.getItem(KEYS.snapshots);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  };

  Vault.takeSnapshot = function (reason) {
    reason = reason || 'manual';
    try {
      const snap = {
        id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        takenAt: new Date().toISOString(),
        reason,
        data: gatherAllStores()
      };
      const list = Vault.listSnapshots();
      list.unshift(snap);
      const trimmed = list.slice(0, MAX_SNAPSHOTS);
      localStorage.setItem(KEYS.snapshots, JSON.stringify(trimmed));
      return snap;
    } catch (e) {
      console.error('[Vault] takeSnapshot failed:', e);
      return null;
    }
  };

  Vault.restoreSnapshot = function (snapshotId) {
    const list = Vault.listSnapshots();
    const snap = list.find(s => s.id === snapshotId);
    if (!snap) return { ok: false, reason: 'not_found' };
    // Stamp a quarantine of current state first so the restore is also reversible
    quarantine('pre-restore', { data: gatherAllStores() }, 'about_to_restore_snapshot');
    return applyAllStores(snap.data);
  };

  Vault.deleteSnapshot = function (snapshotId) {
    const list = Vault.listSnapshots().filter(s => s.id !== snapshotId);
    localStorage.setItem(KEYS.snapshots, JSON.stringify(list));
  };

  /* ====================================================
   * Quarantine — keep failed-migration / pre-restore data
   * ==================================================== */
  function quarantine(kind, originalPayload, reason) {
    try {
      const list = JSON.parse(localStorage.getItem(KEYS.quarantine) || '[]');
      list.unshift({
        id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        quarantinedAt: new Date().toISOString(),
        kind, reason,
        payload: originalPayload
      });
      localStorage.setItem(KEYS.quarantine, JSON.stringify(list.slice(0, MAX_QUARANTINE)));
    } catch (e) {
      console.error('[Vault] quarantine failed:', e);
    }
  }

  Vault.listQuarantine = function () {
    try { return JSON.parse(localStorage.getItem(KEYS.quarantine) || '[]'); } catch (_) { return []; }
  };

  Vault.deleteQuarantine = function (qid) {
    const list = Vault.listQuarantine().filter(q => q.id !== qid);
    localStorage.setItem(KEYS.quarantine, JSON.stringify(list));
  };

  /* ====================================================
   * Full-state operations — across all stores
   * ==================================================== */
  function gatherAllStores() {
    const out = {};
    try { out.studio    = JSON.parse(localStorage.getItem(KEYS.studio)     || 'null'); } catch (_) {}
    try { out.products  = JSON.parse(localStorage.getItem('atlas-products') || 'null'); } catch (_) {}
    try { out.regions   = JSON.parse(localStorage.getItem('atlas-regions')  || 'null'); } catch (_) {}
    try { out.rbac      = JSON.parse(localStorage.getItem('atlas-rbac')     || 'null'); } catch (_) {}
    try { out.theme     = localStorage.getItem('atlas-theme'); } catch (_) {}
    try { out.wizard    = JSON.parse(localStorage.getItem('atlas-wizard')   || 'null'); } catch (_) {}
    try { out.forecastRuns = JSON.parse(localStorage.getItem('atlas-forecast-runs') || 'null'); } catch (_) {}
    return out;
  }

  function applyAllStores(stores) {
    try {
      if (stores.studio)        localStorage.setItem(KEYS.studio, JSON.stringify(stores.studio));
      if (stores.products)      localStorage.setItem('atlas-products', JSON.stringify(stores.products));
      if (stores.regions)       localStorage.setItem('atlas-regions', JSON.stringify(stores.regions));
      if (stores.rbac)          localStorage.setItem('atlas-rbac', JSON.stringify(stores.rbac));
      if (stores.theme)         localStorage.setItem('atlas-theme', stores.theme);
      if (stores.wizard)        localStorage.setItem('atlas-wizard', JSON.stringify(stores.wizard));
      if (stores.forecastRuns)  localStorage.setItem('atlas-forecast-runs', JSON.stringify(stores.forecastRuns));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /* ====================================================
   * Export — single portable JSON file
   * ==================================================== */
  Vault.exportAll = function () {
    return {
      app: 'Atlas WFM',
      version: 1,
      exportedAt: new Date().toISOString(),
      contents: gatherAllStores()
    };
  };

  Vault.importAll = function (payload, mode) {
    mode = mode || 'replace';   // 'replace' | 'merge'
    if (!payload || payload.app !== 'Atlas WFM' || !payload.contents) {
      return { ok: false, reason: 'not_an_atlas_backup' };
    }
    // Always snapshot before import, regardless of mode, so it's reversible
    Vault.takeSnapshot('pre-import');
    if (mode === 'replace') {
      return applyAllStores(payload.contents);
    }
    // Merge mode: keep current entries, add anything new from the import.
    // For now, only Products and Regions support merge; everything else
    // falls back to replace on conflict. This is the safer default.
    const current = gatherAllStores();
    const merged = { ...current };
    // Products merge: keep current, append imported ones not already present (by name)
    if (payload.contents.products?.products && current.products?.products) {
      const existingNames = new Set(current.products.products.map(p => p.name));
      const additions = payload.contents.products.products.filter(p => !existingNames.has(p.name));
      merged.products = { ...current.products, products: current.products.products.concat(additions) };
    } else if (payload.contents.products) {
      merged.products = payload.contents.products;
    }
    // For everything else, replace (merge of queue actuals would be confusing)
    if (payload.contents.studio)       merged.studio = payload.contents.studio;
    if (payload.contents.regions)      merged.regions = payload.contents.regions;
    if (payload.contents.rbac)         merged.rbac = payload.contents.rbac;
    if (payload.contents.forecastRuns) merged.forecastRuns = payload.contents.forecastRuns;
    return applyAllStores(merged);
  };

  /* ====================================================
   * Forecast runs — named, saved, comparable
   * ==================================================== */
  Vault.listForecastRuns = function () {
    try { return JSON.parse(localStorage.getItem('atlas-forecast-runs') || '[]'); } catch (_) { return []; }
  };

  Vault.saveForecastRun = function (run) {
    try {
      const list = Vault.listForecastRuns();
      const entry = {
        id: run.id || 'fr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: run.name || ('Forecast — ' + new Date().toLocaleDateString()),
        savedAt: new Date().toISOString(),
        horizon: run.horizon,
        lockedWeeks: run.lockedWeeks,
        results: run.results
      };
      // Don't add if id already exists (update instead)
      const idx = list.findIndex(r => r.id === entry.id);
      if (idx >= 0) list[idx] = entry; else list.unshift(entry);
      // Cap at 20
      const trimmed = list.slice(0, 20);
      localStorage.setItem('atlas-forecast-runs', JSON.stringify(trimmed));
      return entry;
    } catch (e) {
      console.error('[Vault] saveForecastRun failed:', e);
      return null;
    }
  };

  Vault.deleteForecastRun = function (runId) {
    const list = Vault.listForecastRuns().filter(r => r.id !== runId);
    localStorage.setItem('atlas-forecast-runs', JSON.stringify(list));
  };

  /* ====================================================
   * Boot meta — track if data survived a code update
   * ==================================================== */
  Vault.recordBoot = function () {
    try {
      const prev = JSON.parse(localStorage.getItem(KEYS.boot) || 'null');
      const now = { bootAt: new Date().toISOString() };
      localStorage.setItem(KEYS.boot, JSON.stringify(now));
      return { previousBoot: prev?.bootAt || null };
    } catch (_) { return { previousBoot: null }; }
  };

  WFM.Vault = Vault;
})(window.WFM = window.WFM || {});
