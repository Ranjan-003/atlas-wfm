/* =========================================================
 * Products — top-level grouping for queues
 *
 * A product is a logical bucket of related queues (e.g. "Server Hardware"
 * containing the queues "Dell Servers", "HP Servers", "IBM Servers"). Each
 * queue may carry its own channels and regions; the product is the higher
 * level at which forecasts/capacity roll up for executive review.
 *
 * Storage: localStorage 'atlas-products' with a schema version. Older
 * snapshots are discarded on version bump.
 * ========================================================= */
(function (WFM) {
  'use strict';

  const STORAGE_KEY = 'atlas-products';
  const SCHEMA_VERSION = 1;

  /* Default seed: empty list. Products are user-created — we don't want to
   * presume a hierarchy. The "Unassigned" bucket is a UI concept (queues with
   * no productId), not a real product. */
  const DEFAULT_PRODUCTS = [];

  let state = load();
  const listeners = new Set();

  function load() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.schema === SCHEMA_VERSION && Array.isArray(parsed.products)) {
          return parsed;
        }
      }
    } catch (_) {}
    return freshDefaults();
  }

  function freshDefaults() {
    return { schema: SCHEMA_VERSION, products: JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)) };
  }

  function save() {
    state.schema = SCHEMA_VERSION;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    for (const fn of listeners) fn(state);
  }

  /* ====================================================
   * Public API
   * ==================================================== */
  const P = {};

  P.list = function () { return state.products.slice(); };

  P.get = function (id) { return state.products.find(p => p.id === id) || null; };

  P.add = function (product) {
    if (!product || !product.name) return false;
    const id = product.id || ('p_' + Math.random().toString(36).slice(2, 9));
    if (state.products.some(p => p.id === id)) return false;
    const next = {
      id,
      name: String(product.name).trim(),
      description: product.description || '',
      color: product.color || randomColor(),
      defaultRegions: Array.isArray(product.defaultRegions) ? product.defaultRegions.slice() : [],
      createdAt: new Date().toISOString()
    };
    state.products.push(next);
    save();
    return next;
  };

  P.update = function (id, patch) {
    const p = state.products.find(x => x.id === id);
    if (!p) return false;
    if (patch.name !== undefined)            p.name = String(patch.name).trim();
    if (patch.description !== undefined)     p.description = patch.description;
    if (patch.color !== undefined)           p.color = patch.color;
    if (patch.defaultRegions !== undefined)  p.defaultRegions = patch.defaultRegions.slice();
    save();
    return true;
  };

  P.delete = function (id) {
    const before = state.products.length;
    state.products = state.products.filter(p => p.id !== id);
    if (state.products.length === before) return false;
    save();
    return true;
  };

  P.resetToDefaults = function () {
    state = freshDefaults();
    save();
  };

  P.subscribe = function (fn) { listeners.add(fn); return () => listeners.delete(fn); };

  /* Compute summary stats for a product given the current Workbench queues.
   * Used by the Products page and the sidebar rollup. */
  P.summary = function (productId, queues) {
    queues = queues || [];
    const members = queues.filter(q => (q.productId || null) === productId);
    let channelCount = 0;
    let weeksWithData = 0;
    let totalWeeklyVol = 0;
    let weekTallies = 0;
    for (const q of members) {
      const channels = q.channels || [];
      channelCount += channels.length;
      const data = q.channelData || {};
      for (const ch of channels) {
        const arr = data[ch] || [];
        const nonZero = arr.filter(v => v > 0);
        if (nonZero.length > 0) weeksWithData++;
        totalWeeklyVol += nonZero.reduce((s, v) => s + v, 0);
        weekTallies += nonZero.length;
      }
    }
    return {
      queueCount: members.length,
      channelCount,
      seriesWithData: weeksWithData,
      avgWeeklyVolume: weekTallies > 0 ? totalWeeklyVol / weekTallies : 0
    };
  };

  function randomColor() {
    const palette = ['#b45309', '#0e7490', '#15803d', '#7c3aed', '#be123c', '#1e40af', '#9a3412', '#0f766e'];
    return palette[Math.floor(Math.random() * palette.length)];
  }

  WFM.Products = P;
})(window.WFM = window.WFM || {});
