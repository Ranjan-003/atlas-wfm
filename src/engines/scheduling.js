/* =========================================================
 * Scheduling Engine
 * ---------------------------------------------------------
 * Translates Net-FTE-per-interval into agent shift assignments.
 *
 *   - Shift catalog: defines valid shift patterns
 *   - Greedy + local search fitter: assigns shifts to cover
 *     the requirement curve while respecting constraints
 *   - Coverage scorer: under/over staffing per interval
 *   - Multi-skill priority routing simulation
 * ========================================================= */
(function (WFM) {
  'use strict';
  const S = {};

  // Standard shift catalog. Times in 30-min interval indices (0..47).
  // 16:00 = interval 32. A shift covers [start, start+length).
  S.shiftCatalog = [
    { id: 'EARLY_8',  label: 'Early 8h',   start: 12, length: 16, breaks: [4, 8, 12] },  // 06:00-14:00
    { id: 'DAY_8',    label: 'Day 8h',     start: 18, length: 16, breaks: [4, 8, 12] },  // 09:00-17:00
    { id: 'LATE_8',   label: 'Late 8h',    start: 24, length: 16, breaks: [4, 8, 12] },  // 12:00-20:00
    { id: 'EVE_8',    label: 'Evening 8h', start: 30, length: 16, breaks: [4, 8, 12] },  // 15:00-23:00
    { id: 'NIGHT_8',  label: 'Night 8h',   start: 42, length: 16, breaks: [4, 8, 12], night: true }, // 21:00-05:00 (next day)
    { id: 'PT_4_M',   label: 'PT 4h AM',   start: 16, length: 8,  breaks: [4] },         // 08:00-12:00
    { id: 'PT_4_P',   label: 'PT 4h PM',   start: 32, length: 8,  breaks: [4] },         // 16:00-20:00
    { id: 'SPLIT',    label: 'Split shift',start: 16, length: 8,  splitGap: 8, splitLen: 8, breaks: [] }
  ];

  // ---------- Coverage scorer ----------
  // requirement: array length INTERVALS (e.g. 48)
  // schedule: array of agents, each { shift, breaks: [start indices] }
  S.intervalCoverage = function (schedule, intervals) {
    const cov = new Array(intervals).fill(0);
    for (const a of schedule) {
      const sh = a.shift;
      if (!sh) continue;
      // Main block
      for (let i=0; i<sh.length; i++) {
        const idx = (sh.start + i) % intervals;
        cov[idx] += 1;
      }
      // Subtract breaks (15-min granularity simplified to interval level)
      for (const b of (sh.breaks || [])) {
        const idx = (sh.start + b) % intervals;
        cov[idx] -= 0.5; // half an interval lost to break
      }
      // Split shift second block
      if (sh.splitGap) {
        const restart = (sh.start + sh.length + sh.splitGap) % intervals;
        for (let i=0; i<sh.splitLen; i++) {
          const idx = (restart + i) % intervals;
          cov[idx] += 1;
        }
      }
    }
    return cov.map(v => Math.max(0, v));
  };

  S.coverageScore = function (cov, req) {
    let under = 0, over = 0, hit = 0;
    for (let i=0; i<req.length; i++) {
      const d = cov[i] - req[i];
      if (d < 0) under += -d;
      else over += d;
      if (cov[i] >= req[i]) hit++;
    }
    return {
      under,
      over,
      coverage: hit / req.length,
      fitPct: 1 - (under / Math.max(1, req.reduce((s,v)=>s+v,0)))
    };
  };

  // ---------- Greedy fitter ----------
  // Assigns shifts to N agents to cover requirement.
  // Strategy: while max(deficit) > 0, pick the shift that maximizes
  // deficit reduction; assign one agent.
  S.fitSchedule = function (req, headcount, allowedShifts) {
    const intervals = req.length;
    const cat = (allowedShifts || S.shiftCatalog).filter(s => !s.splitGap); // skip splits in greedy
    const agents = [];
    let cov = new Array(intervals).fill(0);
    let remainingDeficit = req.map(v => v);

    for (let n=0; n<headcount; n++) {
      // Find shift with max deficit reduction
      let bestShift = null, bestGain = -Infinity;
      for (const sh of cat) {
        let gain = 0;
        for (let i=0; i<sh.length; i++) {
          const idx = (sh.start + i) % intervals;
          gain += Math.min(1, remainingDeficit[idx]);
        }
        for (const b of (sh.breaks || [])) {
          const idx = (sh.start + b) % intervals;
          gain -= 0.5;
        }
        if (gain > bestGain) { bestGain = gain; bestShift = sh; }
      }
      if (!bestShift || bestGain <= 0.5) break;
      agents.push({ shift: bestShift });
      // Apply to coverage & deficit
      for (let i=0; i<bestShift.length; i++) {
        const idx = (bestShift.start + i) % intervals;
        cov[idx] += 1;
        remainingDeficit[idx] = Math.max(0, remainingDeficit[idx] - 1);
      }
      for (const b of (bestShift.breaks || [])) {
        const idx = (bestShift.start + b) % intervals;
        cov[idx] -= 0.5;
      }
    }
    cov = cov.map(v=>Math.max(0,v));
    return { agents, coverage: cov, score: S.coverageScore(cov, req) };
  };

  // ---------- Weekly roster generator ----------
  // For a list of agents, assign 5-of-7 days with weekly off rotation.
  S.weeklyRoster = function (agents, opts) {
    opts = opts || {};
    const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const wkOffPolicy = opts.wkOffPolicy || 'consecutive';
    const roster = agents.map((a, i) => {
      const offStart = (i * 2) % 7;
      const off = wkOffPolicy === 'consecutive'
        ? [offStart, (offStart + 1) % 7]
        : [offStart, (offStart + 3) % 7];
      return {
        agentId: a.id || `A${i+1}`,
        days: days.map((d, idx) => ({
          day: d,
          worked: !off.includes(idx),
          shift: off.includes(idx) ? null : a.shift
        }))
      };
    });
    return roster;
  };

  // ---------- Multi-skill priority routing simulation ----------
  // Skills agents have, demand per skill per interval -> coverage by skill.
  // Strategy: route primary first, then secondary skills proportional to need.
  S.multiSkillSim = function (agents, demand) {
    // demand: { skill: [interval array of required] }
    const skills = Object.keys(demand);
    const intervals = demand[skills[0]].length;
    const supply = {};
    skills.forEach(k => supply[k] = new Array(intervals).fill(0));

    for (let t=0; t<intervals; t++) {
      // Available agents at this interval (those whose shift covers t)
      const avail = agents.filter(a => a.shift && intervalInShift(t, a.shift, intervals));
      // First pass: primary skill
      for (const a of avail) {
        if (demand[a.primary] && supply[a.primary][t] < demand[a.primary][t]) {
          supply[a.primary][t] += 1;
        } else {
          // Secondary skills
          for (const sk of (a.secondary || [])) {
            if (demand[sk] && supply[sk][t] < demand[sk][t]) {
              supply[sk][t] += 1; break;
            }
          }
        }
      }
    }
    const scores = {};
    for (const k of skills) scores[k] = S.coverageScore(supply[k], demand[k]);
    return { supply, scores };
  };

  function intervalInShift(t, sh, intervals) {
    for (let i=0; i<sh.length; i++) {
      if ((sh.start + i) % intervals === t) return true;
    }
    return false;
  }

  // ---------- Shift swap validator ----------
  S.canSwap = function (a, b, rules) {
    rules = rules || {};
    if (rules.sameSkill && a.primary !== b.primary) return { ok: false, reason: 'Skill mismatch' };
    if (rules.maxHoursDelta) {
      const delta = Math.abs((a.shift?.length || 0) - (b.shift?.length || 0));
      if (delta > rules.maxHoursDelta) return { ok: false, reason: 'Hours delta too large' };
    }
    return { ok: true };
  };

  // ---------- Labor compliance checks ----------
  S.complianceCheck = function (roster, country) {
    const issues = [];
    const rules = LABOR_RULES[country] || LABOR_RULES.US;
    for (const r of roster) {
      const workedDays = r.days.filter(d => d.worked).length;
      const totalHours = r.days.reduce((s,d)=> s + (d.shift ? d.shift.length * 0.5 : 0), 0);
      if (totalHours > rules.maxWeeklyHours) {
        issues.push({ agentId: r.agentId, type: 'overtime', detail: `${totalHours}h > ${rules.maxWeeklyHours}h` });
      }
      if (workedDays > rules.maxConsecutiveDays) {
        issues.push({ agentId: r.agentId, type: 'consecutive', detail: `${workedDays} days` });
      }
    }
    return issues;
  };

  const LABOR_RULES = {
    US:  { maxWeeklyHours: 48, maxConsecutiveDays: 6, minBreakBetweenShifts: 10 },
    UK:  { maxWeeklyHours: 48, maxConsecutiveDays: 6, minBreakBetweenShifts: 11 },
    EU:  { maxWeeklyHours: 48, maxConsecutiveDays: 6, minBreakBetweenShifts: 11 },
    IN:  { maxWeeklyHours: 48, maxConsecutiveDays: 6, minBreakBetweenShifts: 12 },
    PH:  { maxWeeklyHours: 48, maxConsecutiveDays: 6, minBreakBetweenShifts: 8  }
  };

  WFM.Scheduling = S;
})(window.WFM = window.WFM || {});
