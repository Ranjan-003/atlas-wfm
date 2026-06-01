/* =========================================================
 * AI Copilot — grounded, deterministic
 * ---------------------------------------------------------
 * Pattern: classify intent → extract entities → call the
 * relevant engine → return an answer that cites the data.
 *
 * NO LLM. Pure intent matching over the platform's own
 * data. Cannot hallucinate because it cannot synthesize
 * anything beyond what the engines compute.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Copilot = {};

  // ---------- Intent definitions ----------
  // Each intent has: name, patterns (regexes), handler(state, entities)
  const INTENTS = [
    {
      name: 'sl_miss',
      patterns: [
        /why (did|is) (.+?) (miss(ing)?|below|under) (its )?sla/i,
        /(.+?) (missed|below|breach(ed|ing)?) sla/i,
        /why (.+?) (low|below) (sl|service level)/i
      ],
      handler: handleSLMiss
    },
    {
      name: 'staffing_need',
      patterns: [
        /how many agents? (do (i|we) need|are needed|required)/i,
        /(staffing|headcount|hc|fte) (need|requirement|required)/i,
        /what(?:'| i)s (my|our) hiring (plan|requirement)/i
      ],
      handler: handleStaffingNeed
    },
    {
      name: 'overstaffed',
      patterns: [
        /which queues? (are|is) overstaffed/i,
        /overstaffed queues?/i,
        /where (am|are) (i|we) (overstaffed|too many agents)/i
      ],
      handler: handleOverstaffed
    },
    {
      name: 'understaffed',
      patterns: [
        /which queues? (are|is) understaffed/i,
        /understaffed queues?/i,
        /where (am|are) (i|we) (understaffed|short)/i
      ],
      handler: handleUnderstaffed
    },
    {
      name: 'forecast_accuracy',
      patterns: [
        /forecast accuracy/i,
        /how accurate (is|are) (my|our|the) forecasts?/i,
        /(wape|mape|smape)/i
      ],
      handler: handleForecastAccuracy
    },
    {
      name: 'whatif_volume',
      patterns: [
        /what if (volume|calls?|contacts?) (goes? up|increases?|rises?|grows?|drops?|decreases?|falls?) (by )?(\d+)\s*%/i,
        /(\+|\-)?(\d+)\s*% (volume|call) (increase|surge|drop|decrease)/i
      ],
      handler: handleWhatIfVolume
    },
    {
      name: 'list_anomalies',
      patterns: [
        /(any |what )?anomal(ies|y)/i,
        /(outliers?|spikes?)/i,
        /what'?s unusual/i
      ],
      handler: handleAnomalies
    },
    {
      name: 'queue_health',
      patterns: [
        /(how is|status of|health of|how(?:'| i)s) (.+?)( performing| doing)?$/i,
        /summary (for|of) (.+)/i
      ],
      handler: handleQueueHealth
    },
    {
      name: 'sl_trend',
      patterns: [
        /sl (trend|history|over time|last (week|month))/i,
        /service level (trend|history|last (week|month))/i
      ],
      handler: handleSLTrend
    },
    {
      name: 'attrition',
      patterns: [
        /attrition/i,
        /turnover/i
      ],
      handler: handleAttrition
    },
    {
      name: 'cost_impact',
      patterns: [
        /(cost|spend|payroll) (impact|of|for)/i,
        /how much (does|will) it cost/i
      ],
      handler: handleCost
    },
    {
      name: 'help',
      patterns: [
        /^(help|what can you do|commands|examples)/i
      ],
      handler: handleHelp
    }
  ];

  // ---------- Entity extraction ----------
  function extractQueue(text, queues) {
    const lo = text.toLowerCase();
    // Exact name match
    for (const q of queues) {
      if (lo.includes(q.name.toLowerCase())) return q;
      if (lo.includes(q.id.toLowerCase())) return q;
    }
    // Token match
    const tokens = lo.split(/\s+/);
    let bestQ = null, bestScore = 0;
    for (const q of queues) {
      const name = q.name.toLowerCase();
      const score = tokens.filter(t => name.includes(t) && t.length > 3).length;
      if (score > bestScore) { bestScore = score; bestQ = q; }
    }
    return bestScore >= 1 ? bestQ : null;
  }

  function extractPercent(text) {
    const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) return null;
    const sign = /(drop|down|decrease|fall|fewer|less)/i.test(text) ? -1 : 1;
    return sign * parseFloat(m[1]) / 100;
  }

  function extractChannel(text) {
    const channels = ['voice','chat','email','backoffice','back office'];
    const lo = text.toLowerCase();
    for (const c of channels) if (lo.includes(c)) return c.replace(' ','');
    return null;
  }

  // ---------- Handlers ----------
  function handleSLMiss(state, q) {
    const queue = q.queue || state.queues.find(qq => qq.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7 < qq.slTarget);
    if (!queue) return { text: "I don't see any queues missing SL in the last week. Want to check a specific queue?" };
    const last7 = queue.history.slice(-7);
    const avgSL = last7.reduce((s,h)=>s+h.sla,0)/7;
    const avgVol = last7.reduce((s,h)=>s+h.volume,0)/7;
    const baseVol = queue.history.slice(-30, -7).reduce((s,h)=>s+h.volume,0)/23;
    const volPct = (avgVol - baseVol) / baseVol;
    const causes = [];
    if (volPct > 0.10) causes.push(`volume ran +${Math.round(volPct*100)}% above the prior 3-week baseline`);
    const lastSL = last7[last7.length-1].sla;
    if (lastSL < avgSL - 0.05) causes.push('SL is still declining day-over-day');
    const ahtTrend = (last7.reduce((s,h)=>s+h.aht,0)/7) / queue.ahtBase;
    if (ahtTrend > 1.05) causes.push(`AHT averaging ${Math.round(ahtTrend*100)}% of baseline — handle time elevated`);
    const reqAgents = WFM.Capacity.requiredAgents(queue.channel, avgVol/8, queue.history[83].aht, { targetSL: queue.slTarget });
    const gap = Math.max(0, reqAgents * 1.4 - queue.headcount);
    if (gap > 0) causes.push(`required net staffing of ${reqAgents} agents/8h vs current effective HC of ${Math.round(queue.headcount/1.4)} = ${Math.round(gap)}-FTE shortfall`);
    const why = causes.length ? causes.join('; ') : 'mix of small factors with no single dominant driver';

    const queueLabel = `<b>${queue.name}</b> [${queue.id}]`;
    return {
      text: `Last 7 days, ${queueLabel} averaged <b>${(avgSL*100).toFixed(1)}%</b> SL vs <b>${(queue.slTarget*100).toFixed(0)}%</b> target. Root drivers: ${why}.`,
      sources: [
        { label: `${queue.id} 7d actuals`, detail: `${last7.length} days · vol ${Math.round(avgVol)} · AHT ${Math.round(last7.reduce((s,h)=>s+h.aht,0)/7)}s` }
      ],
      action: { label: 'Open queue in Intraday →', module: 'intraday', queueId: queue.id }
    };
  }

  function handleStaffingNeed(state, q) {
    const queue = q.queue;
    if (!queue) {
      // Aggregate across all queues
      let totalNet = 0, totalGross = 0;
      for (const qq of state.queues) {
        const last7Vol = qq.history.slice(-7).reduce((s,h)=>s+h.volume,0)/7;
        const reqA = WFM.Capacity.requiredAgents(qq.channel, last7Vol/8, qq.ahtBase, { targetSL: qq.slTarget });
        const fte = WFM.Capacity.fromAgentsToFTE([reqA], { shrinkage: qq.shrinkage, occupancy: qq.occupancyTarget });
        totalNet += fte.netFTE; totalGross += fte.grossFTE;
      }
      return {
        text: `Across all ${state.queues.length} queues, current demand requires <b>${Math.round(totalNet)} Net FTE</b> on the floor, which translates to <b>${Math.round(totalGross)} Gross FTE</b> after shrinkage. Today's headcount: <b>${state.queues.reduce((s,q)=>s+q.headcount,0)}</b>.`,
        sources: [{ label: 'Method', detail: 'Erlang C / concurrency by channel · shrinkage 28-36% · occupancy 82-90%' }],
        action: { label: 'Open Capacity Planner →', module: 'capacity' }
      };
    }
    const last7Vol = queue.history.slice(-7).reduce((s,h)=>s+h.volume,0)/7;
    const reqA = WFM.Capacity.requiredAgents(queue.channel, last7Vol/8, queue.ahtBase, { targetSL: queue.slTarget });
    const fte = WFM.Capacity.fromAgentsToFTE([reqA], { shrinkage: queue.shrinkage, occupancy: queue.occupancyTarget });
    return {
      text: `<b>${queue.name}</b>: at ${Math.round(last7Vol)} contacts/day (7-day avg) and ${queue.ahtBase|0}s AHT, you need <b>${reqA} agents on the phone per 8h block</b> to hit ${(queue.slTarget*100)|0}% SL. That's <b>${Math.round(fte.netFTE)} Net FTE</b> / <b>${Math.round(fte.grossFTE)} Gross FTE</b>.`,
      sources: [
        { label: `${queue.id} demand`, detail: `7d daily avg ${Math.round(last7Vol)} · AHT ${Math.round(queue.ahtBase)}s` },
        { label: 'Method', detail: queue.channel === 'voice' ? 'Erlang C' : queue.channel === 'chat' ? 'Erlang C with concurrency 2.5' : 'Productivity model' }
      ]
    };
  }

  function handleOverstaffed(state) {
    const overs = [];
    for (const q of state.queues) {
      const lastSL = q.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7;
      if (lastSL > q.slTarget + 0.10) {
        const buffer = lastSL - q.slTarget;
        overs.push({ q, buffer });
      }
    }
    overs.sort((a,b)=>b.buffer-a.buffer);
    if (!overs.length) return { text: "No queues are clearly overstaffed — all are within ±10 pts of their SL target." };
    const top = overs.slice(0,5);
    const list = top.map(({q, buffer}) =>
      `<b>${q.name}</b> [${q.id}] — running +${(buffer*100).toFixed(1)}pts above target SL`
    ).join('<br>');
    return {
      text: `${overs.length} queues are running 10+ points above SL target. Top candidates for VTO / reallocation:<br><br>${list}`,
      sources: [{ label: 'Method', detail: '7-day avg SL vs queue target, threshold +10 pts' }],
      action: { label: 'Open Intraday →', module: 'intraday' }
    };
  }

  function handleUnderstaffed(state) {
    const unders = [];
    for (const q of state.queues) {
      const lastSL = q.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7;
      if (lastSL < q.slTarget - 0.05) {
        unders.push({ q, gap: q.slTarget - lastSL });
      }
    }
    unders.sort((a,b)=>b.gap-a.gap);
    if (!unders.length) return { text: 'All queues are within 5 pts of their SL target. No critical understaffing detected.' };
    const top = unders.slice(0,5);
    const list = top.map(({q, gap}) =>
      `<b>${q.name}</b> [${q.id}] — ${(gap*100).toFixed(1)}pts below target`
    ).join('<br>');
    return {
      text: `${unders.length} queues understaffed (5+ pts below SL). Priority order:<br><br>${list}`,
      sources: [{ label: 'Method', detail: '7-day avg SL vs target, threshold -5 pts' }],
      action: { label: 'Open Capacity Planner →', module: 'capacity' }
    };
  }

  function handleForecastAccuracy(state) {
    const acc = state.queues.map(q => ({ q, a: q.forecastAccuracy || 0 }));
    acc.sort((a,b)=>b.a-a.a);
    const avg = acc.reduce((s,x)=>s+x.a,0)/acc.length;
    const best = acc[0], worst = acc[acc.length-1];
    return {
      text: `Across ${state.queues.length} queues, forecast accuracy averages <b>${(avg*100).toFixed(1)}%</b> (1 - WAPE). Best: <b>${best.q.name}</b> at ${(best.a*100).toFixed(1)}%. Worst: <b>${worst.q.name}</b> at ${(worst.a*100).toFixed(1)}%.`,
      sources: [{ label: 'Method', detail: 'Walk-forward validation, last 20% of history, 1-WAPE metric' }],
      action: { label: 'Open Forecasting →', module: 'forecasting' }
    };
  }

  function handleWhatIfVolume(state, q) {
    const pct = q.pct;
    if (pct == null) return { text: 'I need a percentage. Try "what if volume goes up by 20%?"' };
    let totalNew = 0, totalCurrent = 0;
    for (const qq of state.queues) {
      const last7Vol = qq.history.slice(-7).reduce((s,h)=>s+h.volume,0)/7;
      const reqCur = WFM.Capacity.requiredAgents(qq.channel, last7Vol/8, qq.ahtBase, { targetSL: qq.slTarget });
      const reqNew = WFM.Capacity.requiredAgents(qq.channel, (last7Vol*(1+pct))/8, qq.ahtBase, { targetSL: qq.slTarget });
      totalCurrent += reqCur;
      totalNew += reqNew;
    }
    const delta = totalNew - totalCurrent;
    const cost = WFM.Capacity.cost(delta * 1.4, {}); // FTE estimate
    const sign = pct >= 0 ? '+' : '';
    return {
      text: `If volume shifts <b>${sign}${(pct*100).toFixed(0)}%</b> across all queues at current AHT/SL targets, required on-the-phone agents move from <b>${Math.round(totalCurrent)}</b> to <b>${Math.round(totalNew)}</b> (<b>${delta>=0?'+':''}${Math.round(delta)}</b>). Approximate Gross FTE cost impact: <b>$${Math.round(cost/1000)}k / year</b>.`,
      sources: [{ label: 'Method', detail: 'Erlang C/concurrency per channel · cost @ $45k loaded FTE/year' }],
      action: { label: 'Open Scenarios →', module: 'scenarios' }
    };
  }

  function handleAnomalies(state) {
    const items = [];
    for (const q of state.queues) {
      if (q._forecast && q._forecast.anomalies.length) {
        for (const a of q._forecast.anomalies.slice(-2)) {
          items.push({ q, a });
        }
      }
    }
    items.sort((a,b)=>b.a.z - a.a.z);
    if (!items.length) return { text: 'No statistically significant anomalies detected across queues (>3.5σ over MAD).' };
    const top = items.slice(0,5);
    const list = top.map(({q,a}) =>
      `<b>${q.name}</b> day ${a.index} — ${Math.round(a.value)} vs expected ${Math.round(a.expected)} (z=${a.z.toFixed(1)})`
    ).join('<br>');
    return {
      text: `Top anomalies (z-score, robust MAD):<br><br>${list}`,
      sources: [{ label: 'Method', detail: 'Rolling 14-day median ± 3.5×MAD, deterministic across runs' }]
    };
  }

  function handleQueueHealth(state, q) {
    const queue = q.queue;
    if (!queue) return { text: 'Which queue? Try "summary for Tech Support T1" or use a queue ID.' };
    const last7 = queue.history.slice(-7);
    const avgSL = last7.reduce((s,h)=>s+h.sla,0)/7;
    const avgVol = last7.reduce((s,h)=>s+h.volume,0)/7;
    const avgOcc = last7.reduce((s,h)=>s+h.occupancy,0)/7;
    return {
      text: `<b>${queue.name}</b> [${queue.id}, ${queue.channel}]<br>
        • SL (7d): <b>${(avgSL*100).toFixed(1)}%</b> vs ${(queue.slTarget*100)|0}% target<br>
        • Volume (7d/day): <b>${Math.round(avgVol)}</b><br>
        • AHT: <b>${queue.ahtBase|0}s</b> · Occupancy: <b>${(avgOcc*100).toFixed(1)}%</b><br>
        • Headcount: <b>${queue.headcount}</b> · Forecast accuracy: <b>${queue.forecastAccuracy ? (queue.forecastAccuracy*100).toFixed(1)+'%' : 'n/a'}</b>`,
      sources: [{ label: `${queue.id} 7-day window`, detail: '' }],
      action: { label: 'Open Intraday →', module: 'intraday', queueId: queue.id }
    };
  }

  function handleSLTrend(state, q) {
    const queue = q.queue || state.queues[0];
    const sl = queue.history.map(h => h.sla);
    const last = sl.slice(-7).reduce((s,v)=>s+v,0)/7;
    const prev = sl.slice(-14,-7).reduce((s,v)=>s+v,0)/7;
    const dir = last > prev ? 'up' : last < prev ? 'down' : 'flat';
    return {
      text: `<b>${queue.name}</b> SL trend: last 7d <b>${(last*100).toFixed(1)}%</b>, prior 7d <b>${(prev*100).toFixed(1)}%</b> (${dir} ${Math.abs((last-prev)*100).toFixed(1)}pts).`,
      sources: [{ label: `${queue.id}`, detail: '14d daily SL%' }]
    };
  }

  function handleAttrition(state) {
    const avg = state.queues.reduce((s,q)=>s+q.attrition,0)/state.queues.length;
    const high = [...state.queues].sort((a,b)=>b.attrition-a.attrition).slice(0,3);
    return {
      text: `Average annualized attrition: <b>${(avg*100).toFixed(1)}%</b>. Highest-attrition queues:<br><br>${high.map(q=>`<b>${q.name}</b> — ${(q.attrition*100).toFixed(1)}%`).join('<br>')}`,
      sources: [{ label: 'Method', detail: 'Modeled from agent tenure distribution' }]
    };
  }

  function handleCost(state) {
    const totalHC = state.queues.reduce((s,q)=>s+q.headcount,0);
    const cost = WFM.Capacity.cost(totalHC);
    return {
      text: `Current loaded payroll across <b>${state.queues.length}</b> queues and <b>${totalHC}</b> agents: approximately <b>$${(cost/1e6).toFixed(2)}M / year</b> at $45k loaded cost per FTE.`,
      sources: [{ label: 'Assumption', detail: '$45k blended loaded FTE/year; replace with your finance model' }]
    };
  }

  function handleHelp() {
    return {
      text: `I can answer questions grounded in your operational data. Examples:
<br>• Why did Tech Support T1 miss SLA?
<br>• How many agents do I need next month?
<br>• Which queues are overstaffed?
<br>• What if volume goes up by 20%?
<br>• Show me forecast accuracy
<br>• Any anomalies in the last week?
<br>• Summary for Fraud Hotline`,
      sources: [{ label: 'Scope', detail: 'Read-only over forecast / capacity / intraday data. No external knowledge.' }]
    };
  }

  // ---------- Public: classify + answer ----------
  Copilot.answer = function (text, state) {
    const lower = text.trim().toLowerCase();
    if (!lower) return { text: "Ask me anything about your forecast, capacity, or intraday performance." };
    // Try each intent
    for (const intent of INTENTS) {
      for (const pat of intent.patterns) {
        if (pat.test(text)) {
          const entities = {
            queue: extractQueue(text, state.queues),
            pct: extractPercent(text),
            channel: extractChannel(text)
          };
          const r = intent.handler(state, entities);
          r.intent = intent.name;
          return r;
        }
      }
    }
    // Fallback: did they name a queue?
    const queue = extractQueue(text, state.queues);
    if (queue) return handleQueueHealth(state, { queue });
    return {
      text: "I'm not sure how to answer that yet — try asking about forecast accuracy, staffing needs, queue health, anomalies, or scenarios. Type \"help\" for examples.",
      sources: []
    };
  };

  // Pre-built suggested questions
  Copilot.suggestions = [
    'Which queues are understaffed?',
    'What if volume goes up by 15%?',
    'Show me forecast accuracy',
    'Any anomalies in the last week?',
    'How many agents do I need?'
  ];

  WFM.Copilot = Copilot;
})(window.WFM = window.WFM || {});
