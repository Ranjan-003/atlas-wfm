/* =========================================================
 * State Store — minimal reactive store
 *
 * Queue model
 * -----------
 * After Phase 1.5: queues live in `state.studio.queues` (created by
 * the user in the Forecast Workbench). They are the single source of
 * truth. Other modules (Dashboard, Forecasting, Capacity, etc.) get
 * them via `currentQueues()`, which adapts the Workbench shape to the
 * richer shape those modules expect by synthesizing defaults for
 * fields like history / headcount / slTarget on the fly.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const listeners = new Set();
  const state = {
    tenant: null,
    module: 'dashboard',
    queueId: null,
    copilotOpen: false,
    copilotHistory: [],
    data: null,             // tenants/sites/channels reference data (empty queues)
    uploadedData: null,     // CSV upload preview
    scenario: { volPct: 0, ahtPct: 0, shrinkageDelta: 0, attritionMult: 1, deflection: { simple: 0, medium: 0, complex: 0 } },
    intradayTick: 24,
    studio: null            // Workbench state — { queues: [...], periods, ... }
  };

  function get() { return state; }

  // Debounced persistence — saves studio to Vault on every mutation, but
  // coalesces rapid bursts (e.g. typing in a cell) into one write per ~300ms.
  let persistTimer = null;
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (state.studio && WFM.Vault?.saveStudio) {
        WFM.Vault.saveStudio(state.studio);
      }
    }, 300);
  }

  function set(patch) {
    Object.assign(state, patch);
    if ('studio' in patch) schedulePersist();
    for (const fn of listeners) fn(state);
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ====================================================
   * currentQueues — unified access for non-Workbench modules
   *
   * Returns Workbench queues, adapted to the richer shape that legacy
   * modules expect. Since a queue can now own multiple channels, each
   * channel becomes a separate adapted entry (with the channel suffix
   * in the id) so capacity/scheduling/etc. continue to work per-channel.
   * Empty array if the user hasn't created any queues yet.
   * ==================================================== */
  function currentQueues() {
    const studioQueues = state.studio?.queues || [];
    if (studioQueues.length === 0) return [];

    const out = [];
    for (const q of studioQueues) {
      // Normalize: new shape uses q.channels[]/q.channelData{}; older shape
      // had q.channel/q.weeks. Tolerate both for back-compat.
      const channels = Array.isArray(q.channels) && q.channels.length
        ? q.channels
        : (q.channel ? [q.channel] : ['voice']);
      const channelData = q.channelData || (q.weeks ? { [channels[0]]: q.weeks } : {});

      for (const ch of channels) {
        const weeks = channelData[ch] || [];
        if (channels.length === 1) {
          out.push(adaptWorkbenchQueue(q, ch, weeks));
        } else {
          // Multi-channel: emit one virtual queue per channel so each gets
          // its own forecast / capacity calc. ID is suffixed so they're
          // addressable independently.
          out.push(adaptWorkbenchQueue(
            { ...q, id: `${q.id}::${ch}`, name: `${q.name} · ${channelLabel(ch)}` },
            ch, weeks
          ));
        }
      }
    }
    return out;
  }

  function channelLabel(ch) {
    return ({ voice: 'Voice', chat: 'Chat', email: 'Email', web: 'Web Case' })[ch] || ch;
  }

  /* Adapt one (queue, channel, weeklySeries) → legacy queue object. */
  function adaptWorkbenchQueue(q, channel, weeks) {
    const channelDefaults = {
      voice: { slTarget: 0.80, slSec: 20, ahtBase: 295, concurrency: 1 },
      chat:  { slTarget: 0.85, slSec: 30, ahtBase: 420, concurrency: 2.5 },
      email: { slTarget: 0.90, slSec: 14400, ahtBase: 240, concurrency: 1 },
      web:   { slTarget: 0.90, slSec: 14400, ahtBase: 600, concurrency: 1 }
    };
    const ch = channelDefaults[channel] || channelDefaults.voice;
    weeks = weeks || [];

    // Convert weekly history to daily by spreading evenly (7 days per week)
    const dailyHistory = [];
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - weeks.length * 7);
    for (let w = 0; w < weeks.length; w++) {
      const weeklyVol = weeks[w] || 0;
      const daily = weeklyVol / 7;
      for (let d = 0; d < 7; d++) {
        const date = new Date(startDate);
        date.setUTCDate(date.getUTCDate() + w * 7 + d);
        dailyHistory.push({
          date: date.toISOString().slice(0,10),
          volume: Math.round(daily),
          handled: Math.round(daily * 0.97),
          abandoned: Math.round(daily * 0.03),
          aht: ch.ahtBase,
          sla: ch.slTarget
        });
      }
    }

    // Run a quick forecast for accuracy + anomaly counts (best effort)
    let forecast = null;
    let forecastAccuracy = null;
    let anomalyCount = 0;
    if (weeks.length >= 4 && WFM.Forecasting?.forecast) {
      try {
        forecast = WFM.Forecasting.forecast(dailyHistory.map(h => h.volume), { period: 7, horizon: 14 });
        forecastAccuracy = forecast.accuracy;
        anomalyCount = forecast.anomalies?.length || 0;
      } catch (_) {}
    }

    // Required staffing from recent 7-day daily mean
    let headcount = 0;
    if (dailyHistory.length >= 7 && WFM.Capacity) {
      const last7 = dailyHistory.slice(-7);
      const dailyAvg = last7.reduce((s,h)=>s+h.volume, 0) / 7;
      try {
        const req = WFM.Capacity.requiredAgents(channel, dailyAvg / 8, ch.ahtBase, { targetSL: ch.slTarget, concurrency: ch.concurrency });
        headcount = Math.round(req * 1.45);
      } catch (_) {}
    }

    return {
      id: q.id,
      name: q.name,
      tenant: 't1',
      channel: channel,
      sites: ['s1'],
      slTarget: ch.slTarget,
      slSec: ch.slSec,
      concurrency: ch.concurrency,
      ahtBase: ch.ahtBase,
      baseVol: dailyHistory.length ? dailyHistory[dailyHistory.length-1].volume : 0,
      volatility: 0.15,
      history: dailyHistory,
      intervals: [],
      headcount,
      shrinkage: 0.30,
      attrition: 0.20,
      occupancyTarget: 0.85,
      forecastAccuracy,
      anomalyCount,
      _forecast: forecast,
      _workbench: q          // back-pointer so modules can write back if needed
    };
  }

  WFM.State = { get, set, subscribe, currentQueues, adaptWorkbenchQueue };
})(window.WFM = window.WFM || {});
