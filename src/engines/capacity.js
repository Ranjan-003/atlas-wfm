/* =========================================================
 * Capacity Planning Engine
 * ---------------------------------------------------------
 *   - Erlang C (voice, no abandonment)
 *   - Erlang A (with abandonment, finite patience)
 *   - Concurrency model (chat / async)
 *   - Productivity model (backoffice)
 *   - Required FTE with shrinkage / attrition / ramp
 *   - Hiring plan generator with lead time
 *   - SLA risk + occupancy risk scoring
 * ========================================================= */
(function (WFM) {
  'use strict';
  const C = {};

  // ---------- Erlang C ----------
  // callsPerHour, ahtSec, agents -> { sl, asa, occ, pWait }
  C.erlangC = function (callsPerHour, ahtSec, agents, slTargetSec) {
    if (agents <= 0) return { sl: 0, asa: Infinity, occ: 1, pWait: 1 };
    const a = callsPerHour * ahtSec / 3600;   // traffic intensity (erlangs)
    if (a >= agents) {
      return { sl: 0, asa: Infinity, occ: 1, pWait: 1, overload: true };
    }
    // Erlang B as starting point
    let B = 1;
    for (let k=1; k<=agents; k++) {
      B = (a * B) / (k + a * B);
    }
    const rho = a / agents;
    const C_ = B / (1 - rho + rho * B);  // P(wait)
    const asa = (C_ * ahtSec) / (agents - a);
    const targetSec = slTargetSec ?? 20;
    const sl = 1 - C_ * Math.exp(-(agents - a) * targetSec / ahtSec);
    return { sl, asa, occ: rho, pWait: C_ };
  };

  // ---------- Erlang A (with abandonment) ----------
  // Adds finite patience theta (avg seconds before abandon).
  // Simplified Garnett approximation.
  C.erlangA = function (callsPerHour, ahtSec, agents, slTargetSec, patienceSec) {
    if (agents <= 0) return { sl: 0, asa: Infinity, occ: 1, ab: 1 };
    const base = C.erlangC(callsPerHour, ahtSec, agents, slTargetSec);
    if (base.overload) {
      const a = callsPerHour * ahtSec / 3600;
      const overflow = a - agents;
      const ab = Math.min(0.95, overflow / a);
      return { ...base, ab, sl: Math.max(0, 0.10 - ab) };
    }
    // Abandonment reduces P(wait) effectively
    const theta = patienceSec || 90;
    const decay = Math.exp(-base.asa / theta);
    const sl = Math.min(1, base.sl + (1 - base.sl) * (1 - decay) * 0.3);
    const ab = base.pWait * (1 - decay) * 0.5;
    return { ...base, sl, ab };
  };

  // ---------- Required Agents (voice / Erlang C) ----------
  C.requiredAgentsVoice = function (callsPerHour, ahtSec, targetSL, targetSec) {
    if (callsPerHour <= 0) return 0;
    const a = callsPerHour * ahtSec / 3600;
    let n = Math.max(1, Math.ceil(a + 1));
    let res;
    for (let i=0; i<300; i++) {
      res = C.erlangC(callsPerHour, ahtSec, n, targetSec || 20);
      if (res.sl >= targetSL) return n;
      n++;
    }
    return n;
  };

  // ---------- Required Agents (chat / concurrency) ----------
  // Each agent handles `concurrency` parallel sessions; effective AHT divides.
  C.requiredAgentsChat = function (sessionsPerHour, ahtSec, concurrency, targetSL, targetSec) {
    const effectiveAHT = ahtSec / Math.max(1, concurrency);
    return C.requiredAgentsVoice(sessionsPerHour, effectiveAHT, targetSL, targetSec);
  };

  // ---------- Required Agents (email / backlog SLA) ----------
  // Treat as productivity: items/hour per agent.
  C.requiredAgentsEmail = function (volumePerHour, itemsPerAgentHour, slaHours) {
    if (volumePerHour <= 0 || itemsPerAgentHour <= 0) return 0;
    return Math.ceil(volumePerHour / itemsPerAgentHour);
  };

  // ---------- Required Agents (backoffice) ----------
  C.requiredAgentsBO = function (itemsPerDay, itemsPerAgentDay) {
    if (itemsPerAgentDay <= 0) return 0;
    return Math.ceil(itemsPerDay / itemsPerAgentDay);
  };

  // ---------- Channel-aware dispatcher ----------
  C.requiredAgents = function (channel, vol, aht, opts) {
    opts = opts || {};
    switch (channel) {
      case 'voice':      return C.requiredAgentsVoice(vol, aht, opts.targetSL || 0.80, opts.targetSec || 20);
      case 'chat':       return C.requiredAgentsChat(vol, aht, opts.concurrency || 2.5, opts.targetSL || 0.80, opts.targetSec || 30);
      case 'email':      return C.requiredAgentsEmail(vol, opts.itemsPerHour || 4, opts.slaHours || 24);
      case 'backoffice': return C.requiredAgentsBO(vol, opts.itemsPerDay || 30);
      default:           return C.requiredAgentsVoice(vol, aht, opts.targetSL || 0.80);
    }
  };

  // ---------- FTE with shrinkage / occupancy ----------
  // Net FTE = on-the-phone bodies
  // Gross FTE = bodies on the payroll accounting for shrinkage
  C.fromAgentsToFTE = function (intervalAgents, opts) {
    opts = opts || {};
    const occupancyTarget = opts.occupancy || 0.85;
    const shrinkage = opts.shrinkage || 0.30;
    const intervalHrs = opts.intervalHrs || 0.5;
    const productiveHrsPerFTE = (opts.weekHrs || 40) * (1 - shrinkage);
    // Sum demand-hours across intervals
    const demandHrs = sum(intervalAgents.map(a => a * intervalHrs));
    const netFTE = demandHrs / (productiveHrsPerFTE * occupancyTarget);
    const grossFTE = netFTE / (1 - shrinkage);
    return { netFTE, grossFTE, demandHrs, productiveHrsPerFTE };
  };

  // ---------- Ramp curve ----------
  // Returns productivity multiplier by week-since-hire.
  C.rampCurve = function (weeksSinceHire) {
    // Typical curve: training, nesting, ramp, full
    const curve = [0, 0.0, 0.2, 0.4, 0.6, 0.75, 0.85, 0.92, 1.0];
    return curve[Math.min(weeksSinceHire, curve.length - 1)];
  };

  // ---------- Hiring plan generator ----------
  // Given a forward demand curve (weekly net FTE) and current HC, produce a hiring plan.
  C.hiringPlan = function (weeklyNetFTE, currentHC, opts) {
    opts = opts || {};
    const attrition = opts.weeklyAttrition || 0.005; // 0.5%/week ≈ 25% annual
    const leadWeeks = opts.leadWeeks || 4;           // hire-to-class
    const trainWeeks = opts.trainWeeks || 4;         // class-to-floor
    const totalLead = leadWeeks + trainWeeks;
    const plan = [];
    let hc = currentHC;
    let pipeline = new Array(totalLead).fill(0);   // hires moving through the pipeline
    for (let w=0; w<weeklyNetFTE.length; w++) {
      // Attrition removes HC
      const attrited = hc * attrition;
      hc -= attrited;
      // Pipeline graduates today (last cell), shift
      const graduates = pipeline[pipeline.length - 1];
      hc += graduates;
      pipeline = [0, ...pipeline.slice(0, -1)];

      const need = weeklyNetFTE[w];
      const futureNeed = weeklyNetFTE[Math.min(w + totalLead, weeklyNetFTE.length - 1)];
      // Hire to close gap totalLead weeks ahead
      const futureAttrition = hc * (1 - Math.pow(1 - attrition, totalLead));
      const projectedHC = hc - futureAttrition + sum(pipeline);
      const gap = Math.max(0, futureNeed - projectedHC);
      const newHires = Math.ceil(gap);
      pipeline[0] = newHires;
      plan.push({
        week: w,
        hc: Math.round(hc * 10) / 10,
        needed: need,
        gap: Math.round((need - hc) * 10) / 10,
        graduates: Math.round(graduates * 10) / 10,
        newHires,
        attrited: Math.round(attrited * 10) / 10
      });
    }
    return plan;
  };

  // ---------- Risk scoring ----------
  // Composite risk: 0..100
  C.riskScore = function (slActual, slTarget, occActual, occTarget, staffingGapPct) {
    // SL risk
    const slDef = Math.max(0, slTarget - slActual);
    const slR = Math.min(50, slDef * 200);
    // Occupancy risk (over-occupied = burnout)
    const occOver = Math.max(0, occActual - occTarget);
    const occR = Math.min(30, occOver * 200);
    // Staffing gap risk
    const gapR = Math.min(20, Math.abs(staffingGapPct) * 100);
    return Math.round(slR + occR + gapR);
  };

  // ---------- Cost model ----------
  C.cost = function (FTE, opts) {
    opts = opts || {};
    const annualLoadedCost = opts.annualLoadedCost || 45000;
    return FTE * annualLoadedCost;
  };

  function sum(a){ return a.reduce((s,v)=>s+v,0); }

  WFM.Capacity = C;
})(window.WFM = window.WFM || {});
