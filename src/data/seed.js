/* =========================================================
 * Sample Data Generator (seeded, deterministic)
 * ---------------------------------------------------------
 * Builds a realistic operational dataset on load. Same seed
 * → same data every session, so the app behaves predictably.
 *
 * Scale (kept moderate for client performance):
 *   - 5 tenants (BPO multi-client view)
 *   - 24 queues across 4 channels and 3 sites
 *   - 120 agents per queue (sampled, total tracked headcount ~3000)
 *   - 84 days daily history + last 14 days at 30-min intervals
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Data = {};

  // ---------- Seeded PRNG (mulberry32) ----------
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(42);
  const randRange = (a, b) => a + rand() * (b - a);
  const randInt = (a, b) => Math.floor(randRange(a, b + 1));
  const pick = arr => arr[Math.floor(rand() * arr.length)];

  // ---------- Reference dimensions ----------
  const TENANTS = [
    { id: 'ACME',     name: 'Acme Telecom',          industry: 'Telecom',     tier: 'Enterprise' },
    { id: 'ORION',    name: 'Orion Banking',         industry: 'Banking',     tier: 'Enterprise' },
    { id: 'ZEPHYR',   name: 'Zephyr Retail',         industry: 'Retail',      tier: 'Growth' },
    { id: 'AURUM',    name: 'Aurum Insurance',       industry: 'Insurance',   tier: 'Enterprise' },
    { id: 'NIMBUS',   name: 'Nimbus Travel',         industry: 'Travel',      tier: 'Mid-market' }
  ];

  const SITES = [
    { id: 'NYC',   name: 'New York',     timezone: 'America/New_York',   country: 'US' },
    { id: 'MNL',   name: 'Manila',       timezone: 'Asia/Manila',        country: 'PH' },
    { id: 'BLR',   name: 'Bangalore',    timezone: 'Asia/Kolkata',       country: 'IN' }
  ];

  const CHANNELS = [
    { id: 'voice',      label: 'Voice',       slTarget: 0.80, slSec: 20, ahtBase: 360 },
    { id: 'chat',       label: 'Chat',        slTarget: 0.85, slSec: 30, ahtBase: 480, concurrency: 2.5 },
    { id: 'email',      label: 'Email',       slTarget: 0.95, slSec: 14400, ahtBase: 480 },
    { id: 'backoffice', label: 'Back-office', slTarget: 0.95, slSec: 28800, ahtBase: 600 }
  ];

  const QUEUE_TEMPLATES = [
    { tenant:'ACME', name:'Billing Inquiries',  channel:'voice', baseVol: 1800, volatility:0.18, weekend:0.45 },
    { tenant:'ACME', name:'Tech Support T1',    channel:'voice', baseVol: 2400, volatility:0.22, weekend:0.50 },
    { tenant:'ACME', name:'Tech Support T2',    channel:'voice', baseVol: 700,  volatility:0.25, weekend:0.40 },
    { tenant:'ACME', name:'Sales Inbound',      channel:'voice', baseVol: 950,  volatility:0.30, weekend:0.30 },
    { tenant:'ACME', name:'Chat Support',       channel:'chat',  baseVol: 1500, volatility:0.20, weekend:0.60 },
    { tenant:'ACME', name:'Email Inquiries',    channel:'email', baseVol: 850,  volatility:0.15, weekend:0.30 },

    { tenant:'ORION', name:'Card Activations',  channel:'voice', baseVol: 1200, volatility:0.17, weekend:0.55 },
    { tenant:'ORION', name:'Fraud Hotline',     channel:'voice', baseVol: 600,  volatility:0.35, weekend:0.80 },
    { tenant:'ORION', name:'Loan Servicing',    channel:'voice', baseVol: 480,  volatility:0.20, weekend:0.20 },
    { tenant:'ORION', name:'Digital Banking',   channel:'chat',  baseVol: 2200, volatility:0.18, weekend:0.55 },
    { tenant:'ORION', name:'Dispute Processing',channel:'backoffice', baseVol: 320, volatility:0.10, weekend:0.10 },
    { tenant:'ORION', name:'Account Opening',   channel:'backoffice', baseVol: 540, volatility:0.12, weekend:0.10 },

    { tenant:'ZEPHYR', name:'Order Status',      channel:'voice', baseVol: 1400, volatility:0.30, weekend:0.85 },
    { tenant:'ZEPHYR', name:'Returns & Refunds', channel:'voice', baseVol: 1100, volatility:0.28, weekend:0.80 },
    { tenant:'ZEPHYR', name:'Social Care',       channel:'chat',  baseVol: 900,  volatility:0.40, weekend:0.95 },
    { tenant:'ZEPHYR', name:'Customer Email',    channel:'email', baseVol: 1300, volatility:0.20, weekend:0.40 },

    { tenant:'AURUM', name:'New Quotes',         channel:'voice', baseVol: 880,  volatility:0.22, weekend:0.30 },
    { tenant:'AURUM', name:'Claims Intake',      channel:'voice', baseVol: 1500, volatility:0.30, weekend:0.55 },
    { tenant:'AURUM', name:'Claims Processing',  channel:'backoffice', baseVol: 1200, volatility:0.15, weekend:0.10 },
    { tenant:'AURUM', name:'Policy Servicing',   channel:'email', baseVol: 740,  volatility:0.18, weekend:0.30 },

    { tenant:'NIMBUS', name:'Reservations',      channel:'voice', baseVol: 1600, volatility:0.35, weekend:0.95 },
    { tenant:'NIMBUS', name:'Schedule Changes',  channel:'voice', baseVol: 1200, volatility:0.45, weekend:0.85 },
    { tenant:'NIMBUS', name:'Loyalty Chat',      channel:'chat',  baseVol: 700,  volatility:0.25, weekend:0.65 },
    { tenant:'NIMBUS', name:'Group Bookings',    channel:'backoffice', baseVol: 220, volatility:0.18, weekend:0.15 }
  ];

  // ---------- Time helpers ----------
  const today = new Date();
  today.setHours(0,0,0,0);
  const dayOffset = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  const dayKey = (d) => d.toISOString().slice(0,10);

  // ---------- Volume curves ----------
  // Hourly multiplier curve for voice/chat (active 7am-9pm, peak ~10am, 2pm)
  const HOUR_CURVE = [
    0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.04, 0.06, 0.08,
    0.10, 0.09, 0.08, 0.07, 0.09, 0.08, 0.07, 0.06, 0.04, 0.03,
    0.02, 0.01, 0.01, 0.01
  ];
  // Day-of-week multiplier
  const DOW_BASE = [0.95, 1.00, 1.05, 1.05, 1.00, 0.70, 0.55]; // Mon..Sun

  function dailyVolume(template, dayIdx) {
    const d = dayOffset(-83 + dayIdx);
    const dow = (d.getDay() + 6) % 7; // Mon=0
    const trend = 1 + (dayIdx - 42) * 0.0008; // slight upward trend
    const seasonal = 1 + 0.06 * Math.sin((dayIdx / 84) * 2 * Math.PI);
    const noise = 1 + (rand() - 0.5) * template.volatility;
    const isWeekend = dow >= 5;
    const dowMult = isWeekend ? template.weekend : DOW_BASE[dow];
    // Occasional anomalous spike
    const spike = rand() < 0.03 ? 1 + randRange(0.25, 0.65) : 1;
    return Math.max(0, Math.round(template.baseVol * dowMult * trend * seasonal * noise * spike));
  }

  function intervalVolume(dailyTotal) {
    // 48 intervals; distribute via HOUR_CURVE expanded
    const out = new Array(48);
    let total = 0;
    for (let i=0; i<48; i++) {
      const hour = Math.floor(i/2);
      const share = HOUR_CURVE[hour] / 2;
      const noise = 1 + (rand() - 0.5) * 0.20;
      out[i] = Math.max(0, share * dailyTotal * noise);
      total += out[i];
    }
    // Renormalize to dailyTotal
    const factor = dailyTotal / Math.max(1, total);
    return out.map(v => Math.round(v * factor));
  }

  // ---------- Build queues ----------
  // OPT-IN demo data generator. Kept available for development / demos
  // but no longer called on boot — we don't want 24 dummy queues showing up.
  // To use:  WFM.Data.buildDemo()  in the browser console.
  Data.buildDemo = function () {
    const queues = [];
    for (let qi=0; qi<QUEUE_TEMPLATES.length; qi++) {
      const t = QUEUE_TEMPLATES[qi];
      const channel = CHANNELS.find(c => c.id === t.channel);
      // Assign 1-2 sites
      const sites = rand() < 0.5 ? [SITES[qi % 3]] : [SITES[qi % 3], SITES[(qi+1) % 3]];
      const ahtBase = channel.ahtBase * randRange(0.85, 1.15);
      // 84-day daily history
      const history = [];
      for (let d=0; d<84; d++) {
        const vol = dailyVolume(t, d);
        const ahtNoise = 1 + (rand() - 0.5) * 0.10;
        const aht = Math.round(ahtBase * ahtNoise);
        history.push({
          date: dayKey(dayOffset(-83 + d)),
          volume: vol,
          aht,
          sla: clamp(0.82 + (rand() - 0.5) * 0.18, 0.35, 0.99),
          handled: Math.round(vol * (0.92 + rand() * 0.07)),
          abandoned: Math.round(vol * (0.02 + rand() * 0.06)),
          occupancy: clamp(0.78 + (rand() - 0.5) * 0.15, 0.55, 0.95)
        });
      }
      // 14-day interval history (last 14 days)
      const intervals = [];
      for (let d=84-14; d<84; d++) {
        const day = history[d];
        const ints = intervalVolume(day.volume);
        intervals.push({ date: day.date, volumes: ints, aht: day.aht });
      }
      // Headcount (depends on volume + channel)
      const requiredAgents = WFM.Capacity.requiredAgents(channel.id, history[83].volume / 8, ahtBase, { targetSL: channel.slTarget });
      const headcount = Math.round(requiredAgents * (1 + 0.45));  // include shrinkage padding
      queues.push({
        id: `Q${String(qi+1).padStart(3,'0')}`,
        name: t.name,
        tenant: t.tenant,
        channel: t.channel,
        sites: sites.map(s => s.id),
        slTarget: channel.slTarget,
        slSec: channel.slSec,
        concurrency: channel.concurrency,
        ahtBase,
        baseVol: t.baseVol,
        volatility: t.volatility,
        history,
        intervals,
        headcount,
        shrinkage: 0.28 + rand() * 0.08,
        attrition: 0.18 + rand() * 0.14,   // annual
        occupancyTarget: 0.82 + rand() * 0.08,
        forecastAccuracy: null,
        anomalyCount: 0
      });
    }
    // Run forecasting on each to get accuracy + anomaly counts
    for (const q of queues) {
      const vols = q.history.map(h => h.volume);
      const fc = WFM.Forecasting.forecast(vols, { period: 7, horizon: 14 });
      q.forecastAccuracy = fc.accuracy;
      q.anomalyCount = fc.anomalies.length;
      q._forecast = fc;
    }
    return {
      tenants: TENANTS,
      sites: SITES,
      channels: CHANNELS,
      queues
    };
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Default boot: empty queues. Users build their own in the Forecast Workbench.
  // Reference data (tenants/sites/channels) stays available so admin pages render.
  Data.build = function () {
    return {
      tenants: TENANTS,
      sites: SITES,
      channels: CHANNELS,
      queues: []
    };
  };

  WFM.Data = Data;
})(window.WFM = window.WFM || {});
