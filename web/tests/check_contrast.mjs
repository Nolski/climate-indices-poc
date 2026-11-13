// WCAG 2.x contrast of the colour tokens in css/app.css, for the light and the dark set.
// Text pairs must reach 4.5:1; non-text parts (borders of controls, focus ring, chart marks) 3:1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'css', 'app.css'), 'utf8');
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
const light = tokens(/:root\s*\{([^}]*)\}/.exec(css)[1]);
const dark = { ...light, ...tokens(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)[1]) };

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT = [
  ['ink', 'bg'], ['ink', 'surface'], ['ink', 'surface-2'], ['ink', 'accent-soft'], ['ink', 'warn-soft'], ['ink', 'err-soft'],
  ['ink-2', 'bg'], ['ink-2', 'surface'], ['ink-2', 'surface-2'], ['ink-2', 'warn-soft'], ['ink-2', 'err-soft'],
  ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'], ['muted', 'warn-soft'], ['muted', 'err-soft'],
  ['accent', 'bg'], ['accent', 'surface'], ['accent-ink', 'accent'], ['accent-ink', 'focus'],
  ['ok', 'surface'], ['ok', 'bg'], ['warn', 'surface'], ['warn', 'bg'], ['warn', 'warn-soft'], ['err', 'surface'], ['err', 'bg'], ['err', 'err-soft'],
];
const NONTEXT = [
  ['control-border', 'surface'], ['control-border', 'bg'], ['control-border', 'surface-2'],
  ['focus', 'surface'], ['focus', 'bg'], ['accent', 'accent-soft'],
  ['chart-1', 'surface'], ['chart-2', 'surface'], ['chart-trend', 'surface'], ['flag-error', 'surface'], ['flag-warn', 'surface'],
  ['miss-2', 'surface'], ['miss-3', 'surface'], ['ok', 'ok-soft'],
];

let failures = 0;
let worst = { r: 99 };
for (const [name, set] of [['light', light], ['dark', dark]]) {
  for (const [pairs, min] of [[TEXT, 4.5], [NONTEXT, 3]]) {
    for (const [fg, bg] of pairs) {
      if (!set[fg] || !set[bg]) {
        failures += 1;
        console.log('  FAIL  ' + name + ': token missing: ' + fg + ' / ' + bg);
        continue;
      }
      const r = ratio(set[fg], set[bg]);
      if (r < worst.r) worst = { r, name, fg, bg, min };
      if (r < min) {
        failures += 1;
        console.log('  FAIL  ' + name + ': ' + fg + ' ' + set[fg] + ' on ' + bg + ' ' + set[bg] + ' = ' + r.toFixed(2) + ':1 (needs ' + min + ':1)');
      }
    }
  }
}
const n = (TEXT.length + NONTEXT.length) * 2;
if (!failures) console.log('  ok    ' + n + ' colour pairs meet WCAG AA in light and dark (lowest: ' + worst.fg + ' on ' + worst.bg + ', ' + worst.name + ', ' + worst.r.toFixed(2) + ':1 against a minimum of ' + worst.min + ':1)');
else console.log('  ' + failures + ' of ' + n + ' colour pairs fail');
process.exit(failures ? 1 : 0);
