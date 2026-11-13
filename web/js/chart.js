// A small SVG time-series chart, written for this tool instead of pulling in a chart library.
//
// Why not a library: the same SVG string is used on screen and for the SVG/PNG download, so
// what a person sees is what lands in their report; it is themed by CSS (light and dark with no
// re-draw), it can be unit-tested and rasterised from the command line, and it costs a few KB.
//
// renderSvg() and layoutChart() are pure (no DOM). attachChart() adds hover, keyboard and zoom.
//
// Spec:
//   { kind: 'year' | 'day',            x values are decimal years, or day numbers
//     xDomain: [x0, x1],               optional; otherwise taken from the data
//     xPad: 0.5,                       optional padding in x units
//     panels: [ { unit: '°C', series: [...], missingX: [x, ...] } ],   stacked, sharing the x axis
//     cursorX: [...],                  x values the read-out cursor snaps to
//     formatY(v, decimals), formatTick(tick), ariaLabel, missingLabel,
//     title, subtitle, footer }        used in exported files only
//   series: { type: 'line', x, y, color: 'c1' | 'c2' | 'trend', dash, marker: 'circle' | 'square' | '',
//             label, track }           y may contain null (drawn as a gap)
//           { type: 'points', x, y, shape: 'diamond' | 'triangle', color: 'flagError' | 'flagWarn', label }

import { segments, niceScale, timeTicks, nearestIndex } from './shape.js';

// Colours used in exported files (always light, for printing). On screen, CSS overrides these
// presentation attributes through the classes, which is what makes dark mode work.
export const EXPORT_THEME = {
  bg: '#ffffff',
  ink: '#1a1a1a',
  muted: '#5c5b57',
  grid: '#e4e3dd',
  axis: '#a9a8a0',
  c1: '#2a78d6',
  c2: '#eb6834',
  trend: '#33332f',
  flagError: '#c0302f',
  flagWarn: '#8f5200',
};

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';
const DASH = { trend: '7 5', alt: '10 3 2 3' };
const ML = 56;
const MR = 16;

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const r1 = (v) => (Math.round(v * 10) / 10).toString();
const textWidth = (s, size = 12) => String(s).length * size * 0.56;

function legendItems(spec) {
  const items = [];
  for (const p of spec.panels) {
    for (const s of p.series) if (s.label) items.push(s);
  }
  if (spec.missingLabel && spec.panels.some((p) => p.missingX && p.missingX.length)) {
    items.push({ type: 'missing', label: spec.missingLabel });
  }
  return items;
}

export function layoutChart(spec, width) {
  const plotW = Math.max(80, width - ML - MR);
  let y = 6;
  const title = spec.export && spec.title ? { y: y + 16 } : null;
  if (title) y += 24;
  const subtitle = spec.export && spec.subtitle ? { y: y + 12 } : null;
  if (subtitle) y += 20;

  // Legend rows, wrapped to the available width.
  const legend = [];
  // The legend uses the full width of the chart (not just the plot area) so that long labels in
  // other languages still fit on a narrow phone; each item that does not fit starts a new row.
  const LEGEND_X = 8;
  let lx = LEGEND_X;
  let row = 0;
  for (const item of legendItems(spec)) {
    const w = 34 + textWidth(item.label) + 18;
    if (lx > LEGEND_X && lx + w - 18 > width - 4) {
      lx = LEGEND_X;
      row += 1;
    }
    legend.push({ item, x: lx, y: y + 10 + row * 20 });
    lx += w;
  }
  if (legend.length) y += (row + 1) * 20 + 4;

  // Shared x domain.
  let x0 = Infinity;
  let x1 = -Infinity;
  if (spec.xDomain) [x0, x1] = spec.xDomain;
  else {
    for (const p of spec.panels) {
      for (const s of p.series) {
        for (const v of s.x) {
          if (v < x0) x0 = v;
          if (v > x1) x1 = v;
        }
      }
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) {
    x0 = 0;
    x1 = 1;
  }
  const pad = spec.xPad || 0;
  x0 -= pad;
  x1 += pad;
  if (x1 <= x0) x1 = x0 + 1;
  const xs = (v) => ML + ((v - x0) / (x1 - x0)) * plotW;
  const xInv = (px) => x0 + ((px - ML) / plotW) * (x1 - x0);

  const panelH = spec.panelHeight || 200;
  const panels = spec.panels.map((p) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of p.series) {
      for (let i = 0; i < s.y.length; i++) {
        const v = s.y[i];
        if (v == null || s.x[i] < x0 || s.x[i] > x1) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const scale = lo === Infinity ? niceScale(0, 1) : niceScale(lo, hi, panelH < 150 ? 3 : 5);
    const top = y + 26;
    y = top + panelH + 8;
    const ys = (v) => top + panelH - ((v - scale.min) / (scale.max - scale.min)) * panelH;
    return { top, bottom: top + panelH, h: panelH, scale, ys, empty: lo === Infinity };
  });

  const axisY = y - 8;
  y += 16;
  const footer = spec.export && spec.footer ? { y: y + 12 } : null;
  if (footer) y += 20;
  const ticks = timeTicks(spec.kind === 'day' ? 'day' : 'year', x0, x1, Math.max(2, Math.floor(plotW / 78)));
  return { width, height: y + 4, plotW, ml: ML, x0, x1, xs, xInv, panels, legend, title, subtitle, footer, axisY, ticks };
}

// class + presentation attributes. The attributes make exported files self-contained.
function paint(cls, attrs) {
  let s = ' class="' + cls + '"';
  for (const k of Object.keys(attrs)) s += ' ' + k + '="' + attrs[k] + '"';
  return s;
}

function markerShape(shape, x, y, T, color, hollow) {
  const fill = hollow ? paint('ch-fill-bg ch-stroke-' + color, { fill: T.bg, stroke: T[color], 'stroke-width': 2 })
    : paint('ch-fill-' + color + ' ch-ring', { fill: T[color], stroke: T.bg, 'stroke-width': 1 });
  if (shape === 'square') return '<rect x="' + r1(x - 3) + '" y="' + r1(y - 3) + '" width="6" height="6"' + fill + '/>';
  if (shape === 'diamond') {
    return '<path d="M' + r1(x) + ' ' + r1(y - 6) + 'l6 6l-6 6l-6 -6z"' + fill + '/>';
  }
  if (shape === 'triangle') {
    return '<path d="M' + r1(x) + ' ' + r1(y - 6.5) + 'l6 10.5h-12z"' + fill + '/>';
  }
  return '<circle cx="' + r1(x) + '" cy="' + r1(y) + '" r="3"' + fill + '/>';
}

function lineAttrs(s, T) {
  const a = { fill: 'none', stroke: T[s.color] || T.c1, 'stroke-width': s.color === 'trend' ? 1.75 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
  if (s.dash) a['stroke-dasharray'] = DASH[s.dash] || DASH.trend;
  return paint('ch-line ch-stroke-' + (s.color || 'c1'), a);
}

function drawSeries(s, L, P, T, out) {
  if (s.type === 'points') {
    for (let i = 0; i < s.x.length; i++) {
      if (s.y[i] == null || s.x[i] < L.x0 || s.x[i] > L.x1) continue;
      out.push(markerShape(s.shape || 'diamond', L.xs(s.x[i]), P.ys(s.y[i]), T, s.color || 'flagError', s.shape === 'triangle'));
    }
    return;
  }
  let visible = 0;
  for (let i = 0; i < s.x.length; i++) if (s.y[i] != null) visible += 1;
  const spacing = visible > 1 ? L.plotW / visible : L.plotW;
  const showMarkers = Boolean(s.marker) && spacing >= 7;
  let d = '';
  const dots = [];
  for (const [a, b] of segments(s.y)) {
    if (a === b) {
      // A lone value between two gaps still has to be visible.
      dots.push(markerShape(s.marker || 'circle', L.xs(s.x[a]), P.ys(s.y[a]), T, s.color || 'c1', false));
      continue;
    }
    d += 'M';
    for (let i = a; i <= b; i++) {
      d += (i > a ? 'L' : '') + r1(L.xs(s.x[i])) + ' ' + r1(P.ys(s.y[i]));
      if (showMarkers) dots.push(markerShape(s.marker, L.xs(s.x[i]), P.ys(s.y[i]), T, s.color || 'c1', false));
    }
  }
  if (d) out.push('<path d="' + d + '"' + lineAttrs(s, T) + '/>');
  out.push(...dots);
}

function drawLegend(L, T, out) {
  for (const { item, x, y } of L.legend) {
    if (item.type === 'points') {
      out.push(markerShape(item.shape || 'diamond', x + 12, y, T, item.color || 'flagError', item.shape === 'triangle'));
    } else if (item.type === 'missing') {
      out.push(crossPath([x + 12], y, T));
    } else {
      out.push('<path d="M' + r1(x) + ' ' + r1(y) + 'h26"' + lineAttrs(item, T) + '/>');
      if (item.marker) out.push(markerShape(item.marker, x + 13, y, T, item.color || 'c1', false));
    }
    out.push('<text x="' + r1(x + 32) + '" y="' + r1(y + 4) + '"' + paint('ch-text', { fill: T.ink, 'font-size': 12 }) + '>' + esc(item.label) + '</text>');
  }
}

function crossPath(pxs, y, T) {
  let d = '';
  for (const x of pxs) d += 'M' + r1(x - 3) + ' ' + r1(y - 3) + 'l6 6m0 -6l-6 6';
  return '<path d="' + d + '"' + paint('ch-missing', { fill: 'none', stroke: T.muted, 'stroke-width': 1.5 }) + '/>';
}

export function renderSvg(spec, L) {
  const T = EXPORT_THEME;
  const fy = spec.formatY || ((v) => String(v));
  const ft = spec.formatTick || ((tk) => String(tk.y));
  const out = [];
  out.push(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + L.width + '" height="' + L.height + '" viewBox="0 0 ' + L.width + ' ' + L.height +
      '" role="img" aria-label="' + esc(spec.ariaLabel || spec.title || '') + '" font-family="' + FONT + '" font-size="12">',
  );
  // A <title> would pop up as a browser tooltip over the whole chart, so it is for exported files only.
  if (spec.export && (spec.title || spec.ariaLabel)) out.push('<title>' + esc(spec.title || spec.ariaLabel) + '</title>');
  if (spec.export) out.push('<rect width="' + L.width + '" height="' + L.height + '" fill="' + T.bg + '"/>');
  if (L.title) out.push('<text x="12" y="' + L.title.y + '" fill="' + T.ink + '" font-size="15" font-weight="600">' + esc(spec.title) + '</text>');
  if (L.subtitle) out.push('<text x="12" y="' + L.subtitle.y + '" fill="' + T.muted + '" font-size="12">' + esc(spec.subtitle) + '</text>');
  drawLegend(L, T, out);

  const right = L.ml + L.plotW;
  spec.panels.forEach((p, i) => {
    const P = L.panels[i];
    if (p.unit) {
      out.push('<text x="' + (L.ml - 48) + '" y="' + (P.top - 13) + '"' + paint('ch-text-muted', { fill: T.muted, 'font-size': 12 }) + '>' + esc(p.unit) + '</text>');
    }
    let grid = '';
    for (const tv of P.scale.ticks) {
      const gy = r1(P.ys(tv));
      grid += 'M' + L.ml + ' ' + gy + 'H' + r1(right);
      out.push('<text x="' + (L.ml - 8) + '" y="' + r1(P.ys(tv) + 4) + '" text-anchor="end"' + paint('ch-text-muted ch-num', { fill: T.muted, 'font-size': 12 }) + '>' + esc(fy(tv, P.scale.decimals)) + '</text>');
    }
    out.push('<path d="' + grid + '"' + paint('ch-grid', { fill: 'none', stroke: T.grid, 'stroke-width': 1 }) + '/>');
    out.push('<path d="M' + L.ml + ' ' + r1(P.bottom) + 'H' + r1(right) + '"' + paint('ch-axis', { fill: 'none', stroke: T.axis, 'stroke-width': 1 }) + '/>');
    if (p.missingX && p.missingX.length) {
      out.push(crossPath(p.missingX.filter((x) => x >= L.x0 && x <= L.x1).map(L.xs), P.bottom - 7, T));
    }
    if (P.empty && spec.emptyLabel) {
      out.push('<text x="' + r1(L.ml + L.plotW / 2) + '" y="' + r1(P.top + P.h / 2) + '" text-anchor="middle"' + paint('ch-text-muted', { fill: T.muted, 'font-size': 13 }) + '>' + esc(spec.emptyLabel) + '</text>');
    }
    for (const s of p.series) drawSeries(s, L, P, T, out);
  });

  // x axis: tick marks under the last panel, labels kept clear of each other and of the edges.
  const last = L.panels[L.panels.length - 1];
  let tickPath = '';
  let lastEnd = -Infinity;
  for (const tk of L.ticks) {
    const x = L.xs(tk.x);
    const label = ft(tk);
    const w = textWidth(label);
    tickPath += 'M' + r1(x) + ' ' + r1(last.bottom) + 'v5';
    const start = Math.max(2, Math.min(L.width - w - 2, x - w / 2));
    if (start < lastEnd + 8) continue;
    lastEnd = start + w;
    out.push('<text x="' + r1(start + w / 2) + '" y="' + r1(last.bottom + 19) + '" text-anchor="middle"' + paint('ch-text-muted ch-num', { fill: T.muted, 'font-size': 12 }) + '>' + esc(label) + '</text>');
  }
  if (tickPath) out.push('<path d="' + tickPath + '"' + paint('ch-axis', { fill: 'none', stroke: T.axis, 'stroke-width': 1 }) + '/>');
  if (L.footer) out.push('<text x="12" y="' + L.footer.y + '" fill="' + T.muted + '" font-size="10.5">' + esc(spec.footer) + '</text>');

  if (!spec.export) {
    const top = L.panels[0].top;
    out.push('<rect class="ch-sel" x="0" y="' + top + '" width="0" height="' + (last.bottom - top) + '" visibility="hidden"/>');
    out.push('<g class="ch-cursor" visibility="hidden"><path class="ch-cursor-line" d="M0 ' + top + 'V' + last.bottom + '"/>');
    spec.panels.forEach((p, pi) => {
      p.series.forEach((s, si) => {
        if (s.track) out.push('<circle class="ch-cursor-dot ch-fill-' + (s.color || 'c1') + '" r="4.5" data-p="' + pi + '" data-s="' + si + '"/>');
      });
    });
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('');
}

// A complete, self-contained SVG file for download.
export function exportSvg(spec, width = 960) {
  const s = { ...spec, export: true, panelHeight: spec.exportPanelHeight || 300 };
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + renderSvg(s, layoutChart(s, width));
}

// Rasterises an SVG string in the browser (no network involved).
export function svgToPng(svgText, scale = 2) {
  return new Promise((resolve, reject) => {
    const size = /width="([\d.]+)" height="([\d.]+)"/.exec(svgText);
    const w = size ? Number(size[1]) : 960;
    const hgt = size ? Number(size[2]) : 400;
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(hgt * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not draw the chart image'));
    };
    img.src = url;
  });
}

// Puts a chart into `host` and keeps it sized to it. getSpec(width) is called on every draw.
// opts: onCursor(index | -1), onZoom(x0, x1), onReset(), fallbackWidth
export function attachChart(host, getSpec, opts = {}) {
  let spec = null;
  let L = null;
  let idx = -1;
  let lastWidth = 0;
  let frame = 0;
  let drag = null;

  function draw() {
    const w = Math.max(280, Math.floor(host.clientWidth || opts.fallbackWidth || 720));
    lastWidth = w;
    spec = getSpec(w - ML - MR);
    L = layoutChart(spec, w);
    host.innerHTML = renderSvg(spec, L);
    if (idx >= 0) setCursor(Math.min(idx, (spec.cursorX || []).length - 1), false);
  }

  function setCursor(i, notify = true) {
    const g = host.querySelector('.ch-cursor');
    const xs = (spec && spec.cursorX) || [];
    if (!g || i < 0 || i >= xs.length || xs[i] < L.x0 || xs[i] > L.x1) {
      idx = -1;
      if (g) g.setAttribute('visibility', 'hidden');
      if (notify && opts.onCursor) opts.onCursor(-1);
      return;
    }
    idx = i;
    const px = L.xs(xs[i]);
    g.setAttribute('visibility', 'visible');
    const line = g.querySelector('.ch-cursor-line');
    if (line) line.setAttribute('transform', 'translate(' + r1(px) + ' 0)');
    for (const dot of g.querySelectorAll('.ch-cursor-dot')) {
      const p = Number(dot.getAttribute('data-p'));
      const s = spec.panels[p].series[Number(dot.getAttribute('data-s'))];
      const v = s.y[i];
      if (v == null) dot.setAttribute('visibility', 'hidden');
      else {
        dot.setAttribute('visibility', 'inherit');
        dot.setAttribute('cx', r1(px));
        dot.setAttribute('cy', r1(L.panels[p].ys(v)));
      }
    }
    if (notify && opts.onCursor) opts.onCursor(i);
  }

  function toChartX(ev) {
    const svg = host.querySelector('svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    return (ev.clientX - rect.left) * (L.width / rect.width);
  }

  function onMove(ev) {
    if (!L || !spec || !spec.cursorX || !spec.cursorX.length) return;
    const px = toChartX(ev);
    if (px === null) return;
    if (drag) {
      drag.x1 = Math.max(L.ml, Math.min(L.ml + L.plotW, px));
      const sel = host.querySelector('.ch-sel');
      if (sel && Math.abs(drag.x1 - drag.x0) > 4) {
        sel.setAttribute('visibility', 'visible');
        sel.setAttribute('x', r1(Math.min(drag.x0, drag.x1)));
        sel.setAttribute('width', r1(Math.abs(drag.x1 - drag.x0)));
      }
    }
    setCursor(nearestIndex(spec.cursorX, L.xInv(px)));
  }

  function onDown(ev) {
    if (!opts.onZoom || !L || (ev.button !== undefined && ev.button !== 0)) return;
    const px = toChartX(ev);
    if (px === null || px < L.ml || px > L.ml + L.plotW) return;
    drag = { x0: px, x1: px };
    try {
      host.setPointerCapture(ev.pointerId);
    } catch {
      /* not essential */
    }
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    const sel = host.querySelector('.ch-sel');
    if (sel) sel.setAttribute('visibility', 'hidden');
    if (Math.abs(d.x1 - d.x0) > 8) opts.onZoom(L.xInv(Math.min(d.x0, d.x1)), L.xInv(Math.max(d.x0, d.x1)));
  }

  function onKey(ev) {
    const n = ((spec && spec.cursorX) || []).length;
    if (!n) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[ev.key];
    let next = idx;
    if (step) next = idx < 0 ? (step > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, idx + step));
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = n - 1;
    else if (ev.key === 'Escape') next = -1;
    else return;
    ev.preventDefault();
    setCursor(next);
  }

  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);
  host.addEventListener('pointerleave', () => {
    if (!drag) setCursor(-1);
  });
  host.addEventListener('keydown', onKey);
  if (opts.onReset) host.addEventListener('dblclick', opts.onReset);

  let observer = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      const w = Math.max(280, Math.floor(host.clientWidth || 0));
      if (!w || w === lastWidth || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    });
    observer.observe(host);
  }

  draw();
  return {
    draw,
    setCursor,
    get index() {
      return idx;
    },
    destroy() {
      if (observer) observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
