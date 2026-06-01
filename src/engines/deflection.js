/* =========================================================
 * AI Deflection & Scenarios Engine
 * ---------------------------------------------------------
 * When AI/self-service removes the easy contacts, the
 * REMAINING contact mix gets harder. This engine models that
 * shift and propagates it into demand & AHT.
 *
 * Also: what-if scenario propagation across volume / AHT /
 * shrinkage / attrition and the resulting FTE / SL impact.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const D = {};

  // ---------- Contact mix taxonomy ----------
  // Default complexity tiers (typical contact center):
  //   simple   — password resets, balance checks  (~40% vol, AHT 180s)
  //   medium   — order status, basic troubleshoot (~35% vol, AHT 360s)
  //   complex  — billing disputes, escalations    (~25% vol, AHT 720s)
  D.defaultMix = [
    { tier: 'simple',  share: 0.40, aht: 180 },
    { tier: 'medium',  share: 0.35, aht: 360 },
    { tier: 'complex', share: 0.25, aht: 720 }
  ];

  // ---------- Deflection model ----------
  // deflectionByTier: { simple: 0.6, medium: 0.2, complex: 0.05 }
  // Returns new mix, new blended AHT, deflection rate, residual volume share.
  D.applyDeflection = function (volume, mix, deflectionByTier) {
    mix = mix || D.defaultMix;
    deflectionByTier = deflectionByTier || { simple: 0, medium: 0, complex: 0 };
    let residualTotal = 0;
    const residualMix = [];
    for (const m of mix) {
      const def = deflectionByTier[m.tier] ?? 0;
      const survivedShare = m.share * (1 - def);
      residualMix.push({ ...m, share: survivedShare });
      residualTotal += survivedShare;
    }
    // Normalize shares to new total
    const normMix = residualMix.map(m => ({ ...m, normShare: residualTotal === 0 ? 0 : m.share / residualTotal }));
    const newAHT = normMix.reduce((s,m) => s + m.normShare * m.aht, 0);
    const newVolume = volume * residualTotal;
    return {
      newVolume,
      newAHT,
      newMix: normMix,
      deflectionRate: 1 - residualTotal,
      ahtShift: newAHT - mix.reduce((s,m)=>s + m.share*m.aht, 0)
    };
  };

  // ---------- Scenario engine ----------
  // Adjusts demand and assumptions, then recomputes capacity.
  // baseline: { volume, aht, shrinkage, attrition, currentHC }
  // scenario: { volPct, ahtPct, shrinkageDelta, attritionMult, deflection }
  D.runScenario = function (baseline, scenario) {
    const s = scenario || {};
    let volume = baseline.volume * (1 + (s.volPct || 0));
    let aht = baseline.aht * (1 + (s.ahtPct || 0));
    // Apply deflection if specified
    if (s.deflection) {
      const def = WFM.AIDeflection.applyDeflection(volume, baseline.mix, s.deflection);
      volume = def.newVolume;
      aht = def.newAHT;
    }
    const shrinkage = Math.max(0, Math.min(0.6, baseline.shrinkage + (s.shrinkageDelta || 0)));
    const attrition = baseline.attrition * (s.attritionMult || 1);
    // Required FTE for the new demand
    const requiredAgents = WFM.Capacity.requiredAgents(baseline.channel, volume, aht, { targetSL: baseline.targetSL || 0.80 });
    const productiveHrsPerFTE = (40 * (1 - shrinkage));
    const demandHrs = requiredAgents * 0.5;
    const netFTE = demandHrs / (productiveHrsPerFTE * (baseline.occupancyTarget || 0.85));
    const grossFTE = netFTE / (1 - shrinkage);
    return {
      volume, aht, shrinkage, attrition,
      requiredAgents,
      netFTE, grossFTE,
      hcDelta: grossFTE - baseline.currentHC,
      costDelta: WFM.Capacity.cost(grossFTE - baseline.currentHC)
    };
  };

  WFM.AIDeflection = D;
})(window.WFM = window.WFM || {});
