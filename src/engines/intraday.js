/* =========================================================
 * Intraday / RTA Engine
 * ---------------------------------------------------------
 *   - Variance vs forecast (volume, AHT, shrinkage)
 *   - End-of-day SL projection
 *   - Intervention recommender (OT, VTO, skill flex, reroute)
 *   - Adherence scoring
 * ========================================================= */
(function (WFM) {
  'use strict';
  const I = {};

  // ---------- Variance ----------
  // forecast, actual: arrays for completed intervals so far
  I.variance = function (forecast, actual) {
    if (!forecast.length || !actual.length) return null;
    const n = actual.length;
    const fSum = forecast.slice(0, n).reduce((s,v)=>s+v,0);
    const aSum = actual.reduce((s,v)=>s+v,0);
    const pct = fSum === 0 ? 0 : (aSum - fSum) / fSum;
    return { fSum, aSum, deltaAbs: aSum - fSum, deltaPct: pct };
  };

  // ---------- SL Pacing ----------
  // Predict end-of-day SL given current actuals + remaining forecast.
  I.slPacing = function (intradayState) {
    const { actualSL, completedIntervals, totalIntervals, forecastVol, actualVol, currentStaff, requiredStaff } = intradayState;
    if (!completedIntervals) return { projected: null };
    const completedShare = completedIntervals / totalIntervals;
    const remainingShare = 1 - completedShare;
    // Volume variance affects remaining intervals
    const volMult = actualVol > 0 ? (actualVol / Math.max(1, forecastVol)) : 1;
    const staffRatio = currentStaff / Math.max(1, requiredStaff);
    // If understaffed, projected SL on remaining drops proportionally
    const remainingSL = Math.max(0, Math.min(1, 0.80 * Math.min(1, staffRatio) / Math.max(1, volMult)));
    const projected = actualSL * completedShare + remainingSL * remainingShare;
    return {
      projected,
      remainingSL,
      volMult,
      staffRatio,
      atRisk: projected < intradayState.targetSL,
      shortfall: Math.max(0, intradayState.targetSL - projected)
    };
  };

  // ---------- Intervention recommender ----------
  // Given the current intraday state, suggest concrete actions.
  I.recommend = function (state) {
    const recs = [];
    const pacing = I.slPacing(state);
    const remainingHrs = (state.totalIntervals - state.completedIntervals) * 0.5;
    const targetSL = state.targetSL || 0.80;

    if (pacing.projected != null && pacing.projected < targetSL) {
      const gap = Math.ceil(state.requiredStaff - state.currentStaff);
      if (gap > 0) {
        // Tiered: skill flex first, then OT
        recs.push({
          type: 'skill_flex',
          priority: 'high',
          title: `Flex ${gap} agents from low-volume queues`,
          detail: `Pull cross-skilled agents from queues currently above target SL into ${state.queueName}. Estimated SL recovery: +${Math.round(gap * 1.5)}%.`,
          impact: { slGain: Math.min(0.20, gap * 0.015), costPerHour: 0 }
        });
        recs.push({
          type: 'overtime',
          priority: gap > 5 ? 'high' : 'med',
          title: `Offer ${gap} hours of OT`,
          detail: `Send OT broadcast to eligible agents in ${state.queueName}. Lead time ~15 min. Cost: ~$${Math.round(gap * 35)}/hr.`,
          impact: { slGain: Math.min(0.15, gap * 0.012), costPerHour: gap * 35 }
        });
        if (state.callbackEnabled) {
          recs.push({
            type: 'callback',
            priority: 'med',
            title: 'Enable virtual callback option',
            detail: 'Offer callback at >120s wait time. Diverts ~12-18% of waiting calls without abandoning service quality.',
            impact: { slGain: 0.08, costPerHour: 0 }
          });
        }
      }
    } else if (pacing.projected != null && pacing.projected > targetSL + 0.10 && state.currentStaff > state.requiredStaff * 1.10) {
      const excess = Math.floor(state.currentStaff - state.requiredStaff);
      recs.push({
        type: 'vto',
        priority: 'med',
        title: `Offer VTO to ${excess} agents`,
        detail: `Voluntary time off for ${excess} agents. SL buffer remains above ${Math.round(targetSL*100)}%. Cost saving: ~$${Math.round(excess * 22 * remainingHrs)}.`,
        impact: { slGain: -0.04, costPerHour: -excess * 22 }
      });
    }

    // Adherence call-out
    if (state.adherence != null && state.adherence < 0.85) {
      recs.push({
        type: 'adherence',
        priority: 'high',
        title: `Adherence at ${Math.round(state.adherence * 100)}% — below threshold`,
        detail: 'Schedule supervisor huddle. ${Math.round((0.90 - state.adherence) * 100)}% of expected hours not on phone.',
        impact: { slGain: 0.05, costPerHour: 0 }
      });
    }

    return recs.sort((a,b) => priorityRank(b.priority) - priorityRank(a.priority));
  };

  function priorityRank(p) { return p === 'high' ? 3 : p === 'med' ? 2 : 1; }

  // ---------- Adherence ----------
  // scheduled vs actual aux states; returns 0..1
  I.adherence = function (events) {
    if (!events.length) return 1;
    let adherent = 0, total = 0;
    for (const e of events) {
      total += e.scheduledMin;
      adherent += Math.min(e.scheduledMin, e.actualOnStateMin);
    }
    return total === 0 ? 1 : adherent / total;
  };

  // ---------- Live actuals simulator (for demo) ----------
  // Generates plausible "current" actuals up to interval `now` from a forecast curve.
  I.simulateActuals = function (forecast, nowInterval, opts) {
    opts = opts || {};
    const drift = opts.drift ?? 0.08; // +/- 8% drift
    const out = [];
    for (let i=0; i<=nowInterval; i++) {
      const noise = 1 + (Math.sin(i*1.7) * drift + (hash01(i) - 0.5) * drift * 1.4);
      out.push(Math.max(0, Math.round(forecast[i] * noise)));
    }
    return out;
  };

  function hash01(n) {
    // deterministic pseudo-random in [0,1)
    let x = Math.sin(n * 9301 + 49297) * 233280;
    return x - Math.floor(x);
  }

  WFM.Intraday = I;
})(window.WFM = window.WFM || {});
