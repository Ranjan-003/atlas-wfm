/* =========================================================
 * Regions & Holidays
 *
 * Each region has:
 *   - id          : short code, e.g. 'AMER'
 *   - label       : human label
 *   - holidays    : [{ id, name, date: 'YYYY-MM-DD', impactMult?, impactDelta?, note? }]
 *
 * Holiday impact:
 *   - impactMult  : multiplicative factor on baseline volume (e.g. 0.3 = volume drops to 30%,
 *                   1.8 = volume goes to 180%). Default for null = 1.0 (no impact).
 *   - impactDelta : absolute additive change. Used together with mult if both present.
 *
 * Storage: localStorage 'atlas-regions' with schema versioning so older data
 * is discarded if the default catalogue changes.
 * ========================================================= */
(function (WFM) {
  'use strict';

  const STORAGE_KEY = 'atlas-regions';
  const SCHEMA_VERSION = 1;

  /* Default regions with pre-populated holiday calendars for 2024-2026.
   * The user can edit, delete, or add to these freely. */
  const DEFAULT_REGIONS = [
    {
      id: 'AMER',
      label: 'AMER (US / Canada)',
      holidays: [
        // 2024
        { id: 'h_us_nyd24',  name: "New Year's Day",      date: '2024-01-01', impactMult: 0.30 },
        { id: 'h_us_mlk24',  name: 'MLK Day',             date: '2024-01-15', impactMult: 0.65 },
        { id: 'h_us_mem24',  name: 'Memorial Day',        date: '2024-05-27', impactMult: 0.50 },
        { id: 'h_us_jul24',  name: 'Independence Day',    date: '2024-07-04', impactMult: 0.40 },
        { id: 'h_us_lab24',  name: 'Labor Day',           date: '2024-09-02', impactMult: 0.50 },
        { id: 'h_us_thx24',  name: 'Thanksgiving',        date: '2024-11-28', impactMult: 0.25 },
        { id: 'h_us_blk24',  name: 'Black Friday',        date: '2024-11-29', impactMult: 1.65, note: 'Retail spike — adjust per industry' },
        { id: 'h_us_xmas24', name: 'Christmas Day',       date: '2024-12-25', impactMult: 0.20 },
        // 2025
        { id: 'h_us_nyd25',  name: "New Year's Day",      date: '2025-01-01', impactMult: 0.30 },
        { id: 'h_us_mlk25',  name: 'MLK Day',             date: '2025-01-20', impactMult: 0.65 },
        { id: 'h_us_mem25',  name: 'Memorial Day',        date: '2025-05-26', impactMult: 0.50 },
        { id: 'h_us_jul25',  name: 'Independence Day',    date: '2025-07-04', impactMult: 0.40 },
        { id: 'h_us_lab25',  name: 'Labor Day',           date: '2025-09-01', impactMult: 0.50 },
        { id: 'h_us_thx25',  name: 'Thanksgiving',        date: '2025-11-27', impactMult: 0.25 },
        { id: 'h_us_blk25',  name: 'Black Friday',        date: '2025-11-28', impactMult: 1.65 },
        { id: 'h_us_xmas25', name: 'Christmas Day',       date: '2025-12-25', impactMult: 0.20 },
        // 2026
        { id: 'h_us_nyd26',  name: "New Year's Day",      date: '2026-01-01', impactMult: 0.30 },
        { id: 'h_us_mlk26',  name: 'MLK Day',             date: '2026-01-19', impactMult: 0.65 },
        { id: 'h_us_mem26',  name: 'Memorial Day',        date: '2026-05-25', impactMult: 0.50 },
        { id: 'h_us_jul26',  name: 'Independence Day',    date: '2026-07-04', impactMult: 0.40 },
        { id: 'h_us_lab26',  name: 'Labor Day',           date: '2026-09-07', impactMult: 0.50 },
        { id: 'h_us_thx26',  name: 'Thanksgiving',        date: '2026-11-26', impactMult: 0.25 },
        { id: 'h_us_blk26',  name: 'Black Friday',        date: '2026-11-27', impactMult: 1.65 },
        { id: 'h_us_xmas26', name: 'Christmas Day',       date: '2026-12-25', impactMult: 0.20 }
      ]
    },
    {
      id: 'EMEA',
      label: 'EMEA (UK / EU)',
      holidays: [
        { id: 'h_uk_nyd24',  name: "New Year's Day",      date: '2024-01-01', impactMult: 0.25 },
        { id: 'h_uk_efr24',  name: 'Good Friday',         date: '2024-03-29', impactMult: 0.45 },
        { id: 'h_uk_emo24',  name: 'Easter Monday',       date: '2024-04-01', impactMult: 0.45 },
        { id: 'h_uk_emy24',  name: 'Early May Bank Hol.', date: '2024-05-06', impactMult: 0.55 },
        { id: 'h_uk_spr24',  name: 'Spring Bank Holiday', date: '2024-05-27', impactMult: 0.55 },
        { id: 'h_uk_sum24',  name: 'Summer Bank Holiday', date: '2024-08-26', impactMult: 0.55 },
        { id: 'h_uk_xmas24', name: 'Christmas Day',       date: '2024-12-25', impactMult: 0.15 },
        { id: 'h_uk_box24',  name: 'Boxing Day',          date: '2024-12-26', impactMult: 0.25 },
        { id: 'h_uk_nyd25',  name: "New Year's Day",      date: '2025-01-01', impactMult: 0.25 },
        { id: 'h_uk_efr25',  name: 'Good Friday',         date: '2025-04-18', impactMult: 0.45 },
        { id: 'h_uk_emo25',  name: 'Easter Monday',       date: '2025-04-21', impactMult: 0.45 },
        { id: 'h_uk_emy25',  name: 'Early May Bank Hol.', date: '2025-05-05', impactMult: 0.55 },
        { id: 'h_uk_spr25',  name: 'Spring Bank Holiday', date: '2025-05-26', impactMult: 0.55 },
        { id: 'h_uk_sum25',  name: 'Summer Bank Holiday', date: '2025-08-25', impactMult: 0.55 },
        { id: 'h_uk_xmas25', name: 'Christmas Day',       date: '2025-12-25', impactMult: 0.15 },
        { id: 'h_uk_box25',  name: 'Boxing Day',          date: '2025-12-26', impactMult: 0.25 },
        { id: 'h_uk_nyd26',  name: "New Year's Day",      date: '2026-01-01', impactMult: 0.25 },
        { id: 'h_uk_efr26',  name: 'Good Friday',         date: '2026-04-03', impactMult: 0.45 },
        { id: 'h_uk_emo26',  name: 'Easter Monday',       date: '2026-04-06', impactMult: 0.45 },
        { id: 'h_uk_emy26',  name: 'Early May Bank Hol.', date: '2026-05-04', impactMult: 0.55 },
        { id: 'h_uk_spr26',  name: 'Spring Bank Holiday', date: '2026-05-25', impactMult: 0.55 },
        { id: 'h_uk_sum26',  name: 'Summer Bank Holiday', date: '2026-08-31', impactMult: 0.55 },
        { id: 'h_uk_xmas26', name: 'Christmas Day',       date: '2026-12-25', impactMult: 0.15 },
        { id: 'h_uk_box26',  name: 'Boxing Day',          date: '2026-12-26', impactMult: 0.25 }
      ]
    },
    {
      id: 'APJ',
      label: 'APJ (India / Japan / SEA)',
      holidays: [
        { id: 'h_in_rep24',  name: 'Republic Day (IN)',   date: '2024-01-26', impactMult: 0.40 },
        { id: 'h_in_hol24',  name: 'Holi',                date: '2024-03-25', impactMult: 0.55 },
        { id: 'h_in_ind24',  name: 'Independence Day (IN)', date: '2024-08-15', impactMult: 0.40 },
        { id: 'h_in_gan24',  name: 'Gandhi Jayanti',      date: '2024-10-02', impactMult: 0.45 },
        { id: 'h_in_diw24',  name: 'Diwali',              date: '2024-11-01', impactMult: 0.35 },
        { id: 'h_jp_nyd24',  name: "New Year (JP)",       date: '2024-01-01', impactMult: 0.20 },
        { id: 'h_jp_gw24',   name: 'Golden Week (JP)',    date: '2024-05-03', impactMult: 0.45 },
        { id: 'h_in_xmas24', name: 'Christmas Day',       date: '2024-12-25', impactMult: 0.55 },
        { id: 'h_in_rep25',  name: 'Republic Day (IN)',   date: '2025-01-26', impactMult: 0.40 },
        { id: 'h_in_hol25',  name: 'Holi',                date: '2025-03-14', impactMult: 0.55 },
        { id: 'h_in_ind25',  name: 'Independence Day (IN)', date: '2025-08-15', impactMult: 0.40 },
        { id: 'h_in_gan25',  name: 'Gandhi Jayanti',      date: '2025-10-02', impactMult: 0.45 },
        { id: 'h_in_diw25',  name: 'Diwali',              date: '2025-10-20', impactMult: 0.35 },
        { id: 'h_jp_nyd25',  name: "New Year (JP)",       date: '2025-01-01', impactMult: 0.20 },
        { id: 'h_jp_gw25',   name: 'Golden Week (JP)',    date: '2025-05-03', impactMult: 0.45 },
        { id: 'h_in_xmas25', name: 'Christmas Day',       date: '2025-12-25', impactMult: 0.55 },
        { id: 'h_in_rep26',  name: 'Republic Day (IN)',   date: '2026-01-26', impactMult: 0.40 },
        { id: 'h_in_hol26',  name: 'Holi',                date: '2026-03-03', impactMult: 0.55 },
        { id: 'h_in_ind26',  name: 'Independence Day (IN)', date: '2026-08-15', impactMult: 0.40 },
        { id: 'h_in_diw26',  name: 'Diwali',              date: '2026-11-08', impactMult: 0.35 },
        { id: 'h_jp_nyd26',  name: "New Year (JP)",       date: '2026-01-01', impactMult: 0.20 },
        { id: 'h_jp_gw26',   name: 'Golden Week (JP)',    date: '2026-05-03', impactMult: 0.45 },
        { id: 'h_in_xmas26', name: 'Christmas Day',       date: '2026-12-25', impactMult: 0.55 }
      ]
    },
    {
      id: 'ANZ',
      label: 'ANZ (Australia / NZ)',
      holidays: [
        { id: 'h_au_nyd24',  name: "New Year's Day",      date: '2024-01-01', impactMult: 0.25 },
        { id: 'h_au_aus24',  name: 'Australia Day',       date: '2024-01-26', impactMult: 0.45 },
        { id: 'h_au_anz24',  name: 'ANZAC Day',           date: '2024-04-25', impactMult: 0.55 },
        { id: 'h_au_qb24',   name: "Queen's Birthday",    date: '2024-06-10', impactMult: 0.55 },
        { id: 'h_au_xmas24', name: 'Christmas Day',       date: '2024-12-25', impactMult: 0.15 },
        { id: 'h_au_box24',  name: 'Boxing Day',          date: '2024-12-26', impactMult: 0.25 },
        { id: 'h_au_nyd25',  name: "New Year's Day",      date: '2025-01-01', impactMult: 0.25 },
        { id: 'h_au_aus25',  name: 'Australia Day',       date: '2025-01-27', impactMult: 0.45 },
        { id: 'h_au_anz25',  name: 'ANZAC Day',           date: '2025-04-25', impactMult: 0.55 },
        { id: 'h_au_qb25',   name: "King's Birthday",     date: '2025-06-09', impactMult: 0.55 },
        { id: 'h_au_xmas25', name: 'Christmas Day',       date: '2025-12-25', impactMult: 0.15 },
        { id: 'h_au_box25',  name: 'Boxing Day',          date: '2025-12-26', impactMult: 0.25 },
        { id: 'h_au_nyd26',  name: "New Year's Day",      date: '2026-01-01', impactMult: 0.25 },
        { id: 'h_au_aus26',  name: 'Australia Day',       date: '2026-01-26', impactMult: 0.45 },
        { id: 'h_au_anz26',  name: 'ANZAC Day',           date: '2026-04-25', impactMult: 0.55 },
        { id: 'h_au_qb26',   name: "King's Birthday",     date: '2026-06-08', impactMult: 0.55 },
        { id: 'h_au_xmas26', name: 'Christmas Day',       date: '2026-12-25', impactMult: 0.15 },
        { id: 'h_au_box26',  name: 'Boxing Day',          date: '2026-12-26', impactMult: 0.25 }
      ]
    },
    {
      id: 'LATAM',
      label: 'LATAM (Brazil / Mexico)',
      holidays: [
        { id: 'h_la_nyd24',  name: "New Year's Day",      date: '2024-01-01', impactMult: 0.30 },
        { id: 'h_br_car24',  name: 'Carnival (BR)',       date: '2024-02-12', impactMult: 0.40 },
        { id: 'h_mx_ind24',  name: 'Independence (MX)',   date: '2024-09-16', impactMult: 0.45 },
        { id: 'h_br_ind24',  name: 'Independence (BR)',   date: '2024-09-07', impactMult: 0.45 },
        { id: 'h_la_xmas24', name: 'Christmas Day',       date: '2024-12-25', impactMult: 0.20 },
        { id: 'h_la_nyd25',  name: "New Year's Day",      date: '2025-01-01', impactMult: 0.30 },
        { id: 'h_br_car25',  name: 'Carnival (BR)',       date: '2025-03-03', impactMult: 0.40 },
        { id: 'h_mx_ind25',  name: 'Independence (MX)',   date: '2025-09-16', impactMult: 0.45 },
        { id: 'h_br_ind25',  name: 'Independence (BR)',   date: '2025-09-07', impactMult: 0.45 },
        { id: 'h_la_xmas25', name: 'Christmas Day',       date: '2025-12-25', impactMult: 0.20 },
        { id: 'h_la_nyd26',  name: "New Year's Day",      date: '2026-01-01', impactMult: 0.30 },
        { id: 'h_br_car26',  name: 'Carnival (BR)',       date: '2026-02-17', impactMult: 0.40 },
        { id: 'h_mx_ind26',  name: 'Independence (MX)',   date: '2026-09-16', impactMult: 0.45 },
        { id: 'h_br_ind26',  name: 'Independence (BR)',   date: '2026-09-07', impactMult: 0.45 },
        { id: 'h_la_xmas26', name: 'Christmas Day',       date: '2026-12-25', impactMult: 0.20 }
      ]
    }
  ];

  /* ====================================================
   * State + listeners
   * ==================================================== */
  let state = load();
  const listeners = new Set();

  function load() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.schema === SCHEMA_VERSION && Array.isArray(parsed.regions)) {
          return parsed;
        }
      }
    } catch (_) {}
    return freshDefaults();
  }

  function freshDefaults() {
    return { schema: SCHEMA_VERSION, regions: JSON.parse(JSON.stringify(DEFAULT_REGIONS)) };
  }

  function save() {
    state.schema = SCHEMA_VERSION;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    for (const fn of listeners) fn(state);
  }

  /* ====================================================
   * Public API
   * ==================================================== */
  const Regions = {};

  Regions.list = function () { return state.regions; };

  Regions.get = function (id) { return state.regions.find(r => r.id === id) || null; };

  Regions.addRegion = function (region) {
    if (!region.id || !region.label) return false;
    if (state.regions.some(r => r.id === region.id)) return false;
    state.regions.push({ id: region.id, label: region.label, holidays: [] });
    save();
    return true;
  };

  Regions.updateRegion = function (id, patch) {
    const r = state.regions.find(rr => rr.id === id);
    if (!r) return false;
    if (patch.label !== undefined) r.label = patch.label;
    save();
    return true;
  };

  Regions.deleteRegion = function (id) {
    const before = state.regions.length;
    state.regions = state.regions.filter(r => r.id !== id);
    if (state.regions.length === before) return false;
    save();
    return true;
  };

  Regions.addHoliday = function (regionId, holiday) {
    const r = state.regions.find(rr => rr.id === regionId);
    if (!r) return false;
    const h = {
      id: holiday.id || ('h_' + Math.random().toString(36).slice(2, 9)),
      name: holiday.name,
      date: holiday.date,
      impactMult: holiday.impactMult != null ? +holiday.impactMult : null,
      impactDelta: holiday.impactDelta != null ? +holiday.impactDelta : null,
      note: holiday.note || ''
    };
    r.holidays.push(h);
    r.holidays.sort((a, b) => a.date.localeCompare(b.date));
    save();
    return h;
  };

  Regions.updateHoliday = function (regionId, holidayId, patch) {
    const r = state.regions.find(rr => rr.id === regionId);
    if (!r) return false;
    const h = r.holidays.find(hh => hh.id === holidayId);
    if (!h) return false;
    Object.assign(h, patch);
    if (patch.impactMult !== undefined) h.impactMult = patch.impactMult === '' || patch.impactMult == null ? null : +patch.impactMult;
    if (patch.impactDelta !== undefined) h.impactDelta = patch.impactDelta === '' || patch.impactDelta == null ? null : +patch.impactDelta;
    r.holidays.sort((a, b) => a.date.localeCompare(b.date));
    save();
    return true;
  };

  Regions.deleteHoliday = function (regionId, holidayId) {
    const r = state.regions.find(rr => rr.id === regionId);
    if (!r) return false;
    const before = r.holidays.length;
    r.holidays = r.holidays.filter(h => h.id !== holidayId);
    if (r.holidays.length === before) return false;
    save();
    return true;
  };

  /* Import bulk holidays from parsed-CSV rows.
   * Expected rows: [{name, date, impactMult?, impactDelta?, note?}]
   */
  Regions.bulkImport = function (regionId, rows) {
    const r = state.regions.find(rr => rr.id === regionId);
    if (!r) return { ok: false, reason: 'region_not_found' };
    let added = 0, skipped = 0;
    for (const row of rows) {
      if (!row.name || !row.date) { skipped++; continue; }
      r.holidays.push({
        id: 'h_' + Math.random().toString(36).slice(2, 9),
        name: row.name,
        date: row.date,
        impactMult: row.impactMult != null && row.impactMult !== '' ? +row.impactMult : 0.5,
        impactDelta: row.impactDelta != null && row.impactDelta !== '' ? +row.impactDelta : null,
        note: row.note || ''
      });
      added++;
    }
    r.holidays.sort((a, b) => a.date.localeCompare(b.date));
    save();
    return { ok: true, added, skipped };
  };

  /* Find a holiday on a specific date within any of the given region IDs.
   * Returns the first match (regions are checked in array order). */
  Regions.holidayOn = function (date, regionIds) {
    if (!date) return null;
    const target = String(date).slice(0, 10);
    for (const rid of regionIds || []) {
      const r = state.regions.find(rr => rr.id === rid);
      if (!r) continue;
      const hit = r.holidays.find(h => h.date === target);
      if (hit) return { region: r.id, regionLabel: r.label, holiday: hit };
    }
    return null;
  };

  /* For a date range, return all holidays that fall within it for the given regions.
   * Useful for forecast adjustment: pass the future-week dates, get back the holidays
   * to apply. */
  Regions.holidaysInRange = function (startDate, endDate, regionIds) {
    const start = String(startDate).slice(0, 10);
    const end = String(endDate).slice(0, 10);
    const out = [];
    for (const rid of regionIds || []) {
      const r = state.regions.find(rr => rr.id === rid);
      if (!r) continue;
      for (const h of r.holidays) {
        if (h.date >= start && h.date <= end) {
          out.push({ region: r.id, regionLabel: r.label, holiday: h });
        }
      }
    }
    return out;
  };

  /* Map weekly buckets to holidays. For each ISO-date (week-start),
   * return any holiday in [weekStart, weekStart+6d] that matches any of regionIds. */
  Regions.holidaysForWeeks = function (weekStartDates, regionIds) {
    return weekStartDates.map(d => {
      if (!d) return null;
      const start = String(d).slice(0, 10);
      const startD = new Date(start + 'T00:00:00Z');
      if (isNaN(startD.getTime())) return null;
      const end = new Date(startD.getTime() + 6 * 86400000).toISOString().slice(0, 10);
      const matches = Regions.holidaysInRange(start, end, regionIds);
      return matches.length ? matches : null;
    });
  };

  Regions.resetToDefaults = function () {
    state = freshDefaults();
    save();
  };

  Regions.subscribe = function (fn) { listeners.add(fn); return () => listeners.delete(fn); };

  /* For a queue with per-holiday overrides, return the effective impact for
   * a given holiday. Overrides take precedence; otherwise the regional default
   * is used. Pass q.holidayOverrides (a map keyed by holiday.id). */
  Regions.effectiveImpact = function (holiday, queueOverrides) {
    const override = queueOverrides && queueOverrides[holiday.id];
    if (override) {
      return {
        impactMult:  override.impactMult  != null ? override.impactMult  : holiday.impactMult,
        impactDelta: override.impactDelta != null ? override.impactDelta : holiday.impactDelta,
        source: 'queue'
      };
    }
    return {
      impactMult: holiday.impactMult,
      impactDelta: holiday.impactDelta,
      source: 'region'
    };
  };

  /* Compute the IMPLIED impact factor from a queue's historical actuals for a
   * specific holiday. For each occurrence of the holiday in history, divide
   * the actual volume by a baseline (median of 4 nearby non-holiday weeks).
   * Average across occurrences. Returns null if no occurrences in history.
   *
   * Used by the "AI suggestion" layer in the Holiday Impacts UI:
   *   "Historical impact for this queue: × 0.42 (n=3 occurrences) — apply?"
   */
  Regions.suggestImpactFromHistory = function (weeklyActuals, weekStartDates, holidayName, regionIds) {
    if (!Array.isArray(weeklyActuals) || !Array.isArray(weekStartDates)) return null;
    if (weeklyActuals.length !== weekStartDates.length) return null;
    // Find all weeks tagged with a holiday of the given name
    const weeklyHolidays = Regions.holidaysForWeeks(weekStartDates, regionIds);
    const matches = [];
    for (let i = 0; i < weeklyHolidays.length; i++) {
      const hits = weeklyHolidays[i];
      if (!hits) continue;
      const m = hits.find(h => h.holiday.name === holidayName);
      if (m) matches.push(i);
    }
    if (matches.length === 0) return null;

    // For each match, compute baseline from up to 4 nearby non-holiday weeks
    const ratios = [];
    for (const idx of matches) {
      const window = [];
      const radius = 4;
      for (let j = Math.max(0, idx - radius); j < Math.min(weeklyActuals.length, idx + radius + 1); j++) {
        if (j === idx) continue;
        if (!weeklyHolidays[j]) window.push(weeklyActuals[j]);
      }
      if (window.length === 0) continue;
      const s = [...window].sort((a, b) => a - b);
      const baseline = s[Math.floor(s.length / 2)];
      if (baseline <= 0) continue;
      ratios.push(weeklyActuals[idx] / baseline);
    }
    if (ratios.length === 0) return null;
    const avg = ratios.reduce((s, v) => s + v, 0) / ratios.length;
    return { impliedMult: avg, occurrences: ratios.length };
  };

  WFM.Regions = Regions;
})(window.WFM = window.WFM || {});
