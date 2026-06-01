/* =========================================================
 * Icon library — inline SVG, Feather-style minimal strokes
 * Returns an SVG string. Use as inner HTML.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Icons = {};

  function svg(d, opts) {
    opts = opts || {};
    const sw = opts.sw || 1.6;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  }

  Icons.dashboard    = svg('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>');
  Icons.forecast     = svg('<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/>');
  Icons.capacity     = svg('<path d="M3 3v18h18"/><rect x="6" y="13" width="3" height="5"/><rect x="11" y="9" width="3" height="9"/><rect x="16" y="6" width="3" height="12"/>');
  Icons.schedule     = svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>');
  Icons.intraday     = svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>');
  Icons.deflection   = svg('<polyline points="3 12 9 12"/><polyline points="6 9 3 12 6 15"/><circle cx="17" cy="12" r="4"/><path d="M17 8v4l3 2"/>');
  Icons.scenarios    = svg('<path d="M3 12c0-5 4-9 9-9s9 4 9 9-4 9-9 9-9-4-9-9z"/><path d="M12 3v18M3 12h18"/>');
  Icons.globe        = svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2c2.5 3 4 6.5 4 10s-1.5 7-4 10M12 2c-2.5 3-4 6.5-4 10s1.5 7 4 10"/>');
  Icons.product      = svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>');
  Icons.copilot      = svg('<path d="M12 2l2.39 5.84L20 9.27l-4 4.31L17 20l-5-3-5 3 1-6.42-4-4.31 5.61-1.43z"/>');
  Icons.data         = svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6"/>');
  Icons.analytics    = svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 9 9h-9z"/>');
  Icons.admin        = svg('<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"/>');
  Icons.search       = svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>');
  Icons.bell         = svg('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>');
  Icons.help         = svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7v.5"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/>');
  Icons.user         = svg('<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"/>');
  Icons.spark        = svg('<path d="M12 2v6m0 8v6M2 12h6m8 0h6m-3.5-6.5L13 8m-2 8l-2.5 2.5M5.5 5.5L8 8m8 8l2.5 2.5"/>');
  Icons.send         = svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>');
  Icons.close        = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
  Icons.menu         = svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>');
  Icons.download     = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>');
  Icons.upload       = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>');
  Icons.filter       = svg('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>');
  Icons.refresh      = svg('<path d="M3 12a9 9 0 1 0 3-7"/><polyline points="3 4 3 10 9 10"/>');
  Icons.check        = svg('<polyline points="20 6 9 17 4 12"/>');
  Icons.alert        = svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/>');
  Icons.info         = svg('<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/>');
  Icons.arrow_up     = svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>');
  Icons.arrow_down   = svg('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>');
  Icons.arrow_right  = svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>');
  Icons.arrow_left   = svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>');
  Icons.plus         = svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>');
  Icons.chevron_down = svg('<polyline points="6 9 12 15 18 9"/>');
  Icons.play         = svg('<polygon points="6 4 20 12 6 20 6 4"/>');
  Icons.pause        = svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>');
  Icons.settings     = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>');
  Icons.lightning    = svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>');
  Icons.sun          = svg('<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>');
  Icons.moon         = svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');

  WFM.Icons = Icons;
})(window.WFM = window.WFM || {});
