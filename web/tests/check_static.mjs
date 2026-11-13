// Static checks on the shipped front end. No dependencies. Exits non-zero on any failure.
//   node web/tests/check_static.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(web, rel), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(web, dir)).filter((f) => f.endsWith(ext)).map((f) => dir + '/' + f).sort();

let failures = 0;
const section = (name) => console.log('\n' + name);
const ok = (msg) => console.log('  ok    ' + msg);
const info = (msg) => console.log('  note  ' + msg);
const fail = (msg) => {
  failures += 1;
  console.log('  FAIL  ' + msg);
};
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(msg + (detail ? ': ' + detail : '')));

const html = read('index.html');
const en = JSON.parse(read('i18n/en.json'));
const fr = JSON.parse(read('i18n/fr.json'));
const jsFiles = list('js', '.js');
const cssFiles = list('css', '.css');

// ---------------------------------------------------------------- tiny HTML parser
const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'use', 'path', 'circle', 'rect', 'source', 'wbr']);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function parse(src) {
  const nodes = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w:@.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) {
      const name = m[1].toLowerCase();
      const i = stack.map((n) => n.tag).lastIndexOf(name);
      if (i < 0) throw new Error('closing tag without opening: ' + name);
      if (i !== stack.length - 1) throw new Error('badly nested: </' + name + '> closes <' + stack[stack.length - 1].tag + '>');
      stack.length = i;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = {};
      const ar = /([\w:@.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let a;
      while ((a = ar.exec(m[3]))) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const node = { tag, attrs, text: '', parent: stack[stack.length - 1] || null, children: [] };
      if (node.parent) node.parent.children.push(node);
      nodes.push(node);
      if (!VOID.has(tag) && !m[4]) stack.push(node);
    } else if (m[5]) {
      const text = decode(m[5]);
      for (const n of stack) n.text += text;
    }
  }
  if (stack.length) throw new Error('unclosed tags: ' + stack.map((n) => n.tag).join(', '));
  return nodes;
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const ancestors = (n) => {
  const out = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out;
};

section('HTML structure (index.html)');
let nodes = [];
try {
  nodes = parse(html);
  ok('parses with every tag closed and correctly nested (' + nodes.length + ' elements)');
} catch (e) {
  fail('HTML does not parse: ' + e.message);
}
const byId = new Map();
const dupes = [];
for (const n of nodes) {
  if (n.attrs.id === undefined) continue;
  if (byId.has(n.attrs.id)) dupes.push(n.attrs.id);
  byId.set(n.attrs.id, n);
}
check(dupes.length === 0, 'ids are unique (' + byId.size + ' ids)', dupes.join(', '));

const htmlEl = nodes.find((n) => n.tag === 'html');
check(htmlEl && htmlEl.attrs.lang && htmlEl.attrs.dir, '<html> has lang and dir');
check(nodes.some((n) => n.tag === 'title' && norm(n.text)), 'page has a <title>');
check(nodes.some((n) => n.tag === 'meta' && n.attrs.name === 'viewport' && !/user-scalable\s*=\s*no|maximum-scale/.test(n.attrs.content)), 'viewport meta allows zoom');
check(nodes.filter((n) => n.tag === 'main').length === 1, 'exactly one <main>');
check(nodes.some((n) => n.tag === 'a' && n.attrs.href === '#main') && byId.has('main'), 'skip link points at <main>');
for (const landmark of ['header', 'nav', 'footer']) check(nodes.some((n) => n.tag === landmark && !ancestors(n).some((p) => p.tag === 'svg')), 'has a <' + landmark + '> landmark');

const labelsFor = new Map();
for (const n of nodes) if (n.tag === 'label' && n.attrs.for) labelsFor.set(n.attrs.for, n);
const badFor = [...labelsFor.keys()].filter((id) => !byId.has(id));
check(badFor.length === 0, 'every <label for> points at an existing control', badFor.join(', '));
const controls = nodes.filter((n) => ['input', 'select', 'textarea', 'progress'].includes(n.tag) && n.attrs.type !== 'hidden');
const unlabelled = controls.filter((n) => !(n.attrs.id && labelsFor.has(n.attrs.id)) && !n.attrs['aria-label'] && !n.attrs['aria-labelledby'] && !ancestors(n).some((p) => p.tag === 'label' && norm(p.text)));
check(unlabelled.length === 0, 'every form control has a label (' + controls.length + ' controls)', unlabelled.map((n) => n.attrs.id || n.tag).join(', '));
const radios = controls.filter((n) => n.attrs.type === 'radio');
check(radios.every((n) => ancestors(n).some((p) => p.tag === 'fieldset' && p.children.some((c) => c.tag === 'legend'))), 'radio buttons sit in a fieldset with a legend');

const buttons = nodes.filter((n) => n.tag === 'button' || (n.tag === 'a' && n.attrs.href !== undefined) || n.tag === 'summary');
const mute = buttons.filter((n) => !norm(n.text) && !n.attrs['aria-label']);
check(mute.length === 0, 'every button, link and summary has a text name (' + buttons.length + ')', mute.map((n) => n.attrs.id || n.tag).join(', '));
check(nodes.filter((n) => n.tag === 'button').every((n) => n.attrs.type), 'every <button> states its type');

const refAttrs = ['aria-describedby', 'aria-labelledby', 'aria-controls'];
const badRefs = [];
for (const n of nodes) for (const a of refAttrs) if (n.attrs[a]) for (const id of n.attrs[a].split(/\s+/)) if (!byId.has(id)) badRefs.push(a + '=' + id);
check(badRefs.length === 0, 'aria-describedby / labelledby / controls point at existing ids', badRefs.join(', '));

const heads = nodes.filter((n) => /^h[1-6]$/.test(n.tag)).map((n) => Number(n.tag[1]));
let headOk = heads.filter((l) => l === 1).length === 1 && heads[0] === 1;
for (let i = 1; i < heads.length; i++) if (heads[i] > heads[i - 1] + 1) headOk = false;
check(headOk, 'headings are in order with one <h1> (' + heads.join(' ') + ')');
const sections = nodes.filter((n) => n.tag === 'section');
check(sections.length === 4 && sections.every((n) => n.attrs['aria-labelledby'] && byId.has(n.attrs['aria-labelledby'])), 'four step sections, each named by its heading');
check(nodes.filter((n) => n.attrs['data-step']).length === 4 && nodes.filter((n) => n.attrs['aria-current'] === 'step').length === 1, 'progress indicator has four steps and one current step');
const svgs = nodes.filter((n) => n.tag === 'svg');
check(svgs.every((n) => n.attrs['aria-hidden'] === 'true'), 'decorative inline SVG icons are hidden from assistive technology (' + svgs.length + ')');
const uses = nodes.filter((n) => n.tag === 'use').map((n) => (n.attrs.href || '').slice(1));
check(uses.every((id) => byId.has(id)), 'every icon reference resolves to a symbol', uses.filter((id) => !byId.has(id)).join(', '));
check(nodes.some((n) => n.attrs.role === 'status') && nodes.some((n) => n.attrs.role === 'alert') && nodes.some((n) => n.attrs['aria-live']), 'live regions for status and errors are present');
check(!nodes.some((n) => n.tag === 'img'), 'no <img> elements (inline SVG only)');
check(!nodes.some((n) => Object.keys(n.attrs).some((a) => /^on[a-z]+$/.test(a))), 'no inline event handlers');
check(!nodes.some((n) => n.attrs.style !== undefined) && !nodes.some((n) => n.tag === 'style'), 'no inline styles (works under a strict Content-Security-Policy)');
check(nodes.filter((n) => n.tag === 'script').every((n) => n.attrs.src && n.attrs.type === 'module'), 'scripts are external ES modules only');
check(nodes.some((n) => n.tag === 'meta' && n.attrs['http-equiv'] === 'Content-Security-Policy' && /default-src 'self'/.test(n.attrs.content)), "Content-Security-Policy restricts loading to 'self'");
const positiveTab = nodes.filter((n) => Number(n.attrs.tabindex) > 0);
check(positiveTab.length === 0, 'no positive tabindex (keyboard order follows the page)');

// ---------------------------------------------------------------- translations
section('Translations');
const enKeys = Object.keys(en).sort();
const frKeys = Object.keys(fr).sort();
check(JSON.stringify(enKeys) === JSON.stringify(frKeys), 'en.json and fr.json have identical key sets (' + enKeys.length + ' keys)', [...enKeys.filter((k) => !(k in fr)), ...frKeys.filter((k) => !(k in en))].join(', '));
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();
const phBad = enKeys.filter((k) => k in fr && ph(en[k]) !== ph(fr[k]));
check(phBad.length === 0, 'placeholders match between the two languages', phBad.join(', '));
check(enKeys.every((k) => typeof en[k] === 'string' && en[k].trim()) && frKeys.every((k) => typeof fr[k] === 'string' && fr[k].trim()), 'no empty strings');
const same = enKeys.filter((k) => fr[k] === en[k] && /[a-z]{4}/i.test(en[k]));
info(same.length + ' French strings are identical to English (expected for names such as NetCDF, JSON, Variable, Date): ' + same.join(', '));

const used = new Set();
const prefixes = new Set();
const missing = [];
const htmlMismatch = [];
for (const n of nodes) {
  const k = n.attrs['data-i18n'];
  if (k) {
    used.add(k);
    if (!(k in en)) missing.push('html:' + k);
    else if (norm(n.text) !== norm(en[k])) htmlMismatch.push(k);
  }
  if (n.attrs['data-i18n-attr']) {
    for (const pair of n.attrs['data-i18n-attr'].split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      used.add(key);
      if (!(key in en)) missing.push('html-attr:' + key);
      else if (n.attrs[attr] !== en[key]) htmlMismatch.push(attr + '@' + key);
    }
  }
}
check(htmlMismatch.length === 0, 'English text written in index.html equals en.json for every data-i18n element', htmlMismatch.join(', '));
for (const f of jsFiles) {
  const src = read(f);
  for (const m of src.matchAll(/\b(tn?)\(\s*'([^']+)'\s*(\+|,|\))/g)) {
    const [, fn, key, next] = m;
    if (next === '+') {
      prefixes.add(key);
      if (!enKeys.some((k) => k.startsWith(key))) missing.push(f + ':' + key + '*');
    } else if (fn === 'tn') {
      used.add(key + '.one');
      used.add(key + '.other');
      if (!(key + '.other' in en) || !(key + '.one' in en)) missing.push(f + ':' + key + '.one/.other');
    } else {
      used.add(key);
      if (!(key in en)) missing.push(f + ':' + key);
    }
  }
  for (const m of src.matchAll(/'((?:unit|unitChange|var|conn|group)\.)'\s*\+/g)) prefixes.add(m[1]);
  for (const m of src.matchAll(/\? '([a-z]+\.[A-Za-z.]+)'\s*:\s*'([a-z]+\.[A-Za-z.]+)'/g)) for (const k of [m[1], m[2]]) if (k in en) used.add(k);
}
check(missing.length === 0, 'every translation key used in the HTML and JavaScript exists', missing.join(', '));
const unused = enKeys.filter((k) => !used.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
if (unused.length) info(unused.length + ' keys are not referenced by a literal (may be built dynamically): ' + unused.join(', '));
else ok('no unused translation keys');
const brand = enKeys.filter((k) => /\bWMO\b|Climpact|UNSW/i.test(en[k]) && !['footer.disclaimer', 'about.p1', 'load.format.p2'].includes(k));
check(brand.length === 0 && !/WMO|Climpact|UNSW/i.test(en['app.title']), 'product name and interface text carry no WMO / Climpact / UNSW branding (only the disclaimer, the About text and the file-format note mention them)', brand.join(', '));
check(en['footer.disclaimer'] === 'Independent proof of concept. Not affiliated with or endorsed by WMO or the Climpact maintainers.', 'footer carries the disclaimer from the brief, word for word');
const PRIVACY = 'Your data stays in memory on the server for 60 minutes and is never written to disk.';
check(en['load.privacy'].replace('{minutes}', '60') === PRIVACY && norm(byId.get('privacy-text').text) === PRIVACY, 'privacy statement is present, word for word (the 60 is replaced only if the server reports another retention time)');
check(norm(byId.get('file-limit').text) === en['load.file.limit'].replace('{n}', '20'), 'upload limit text in index.html matches en.json with the default of 20 MB');

// ---------------------------------------------------------------- modules
section('JavaScript modules');
const importsOf = (f) => [...read(f).matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
const reach = new Set();
const unresolved = [];
(function walk(f) {
  if (reach.has(f)) return;
  reach.add(f);
  for (const spec of importsOf(f)) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      unresolved.push(f + ' -> ' + spec + ' (not a relative import)');
      continue;
    }
    const target = path.posix.join(path.posix.dirname(f), spec);
    if (target.startsWith('..') || !fs.existsSync(path.join(web, target))) unresolved.push(f + ' -> ' + spec);
    else walk(target);
  }
})('js/main.js');
check(unresolved.length === 0, 'every import is relative and resolves to a file inside web/ (no bare or external specifiers)', unresolved.join(', '));
const preload = nodes.filter((n) => n.tag === 'link' && n.attrs.rel === 'modulepreload').map((n) => n.attrs.href).sort();
check(JSON.stringify(preload) === JSON.stringify([...reach].sort()), 'modulepreload list equals the module graph (' + reach.size + ' modules, fetched in parallel)', 'preload: ' + preload.join(' ') + ' | graph: ' + [...reach].sort().join(' '));
check(jsFiles.every((f) => reach.has(f)) && reach.has('config.js'), 'no orphan module in web/js, and config.js is part of the graph', jsFiles.filter((f) => !reach.has(f)).join(', '));
globalThis.__CLIMPOC_NO_AUTOBOOT__ = true;
const linkErrors = [];
for (const f of jsFiles) {
  try {
    await import(pathToFileURL(path.join(web, f)).href);
  } catch (e) {
    linkErrors.push(f + ': ' + e.message);
  }
}
check(linkErrors.length === 0, 'every module loads and links under Node (all imported names exist)', linkErrors.join(' | '));
const noDom = ['config.js', 'js/api.js', 'js/shape.js', 'js/i18n.js', 'js/format.js', 'js/store.js'].filter((f) => /\bdocument\.|\bwindow\./.test(read(f)));
check(noDom.length === 0, 'logic modules do not touch the DOM (api, shape, i18n, format, store)', noDom.join(', '));
const risky = jsFiles.filter((f) => /\beval\(|new Function\(|document\.write|insertAdjacentHTML|outerHTML\s*=/.test(read(f)));
check(risky.length === 0, 'no eval, document.write or HTML-string insertion helpers', risky.join(', '));
const inner = jsFiles.flatMap((f) => [...read(f).matchAll(/\.innerHTML\s*=(?!=)/g)].map(() => f));
check(inner.length === 1 && inner[0] === 'js/chart.js', 'innerHTML is assigned in exactly one place (the chart, whose text is escaped)', inner.join(', '));
const rawStorage = jsFiles.filter((f) => f !== 'js/main.js' && /\b(sessionStorage|localStorage)\b/.test(read(f).replace(/\/\/.*$/gm, '')));
check(rawStorage.length === 0 && (read('js/main.js').match(/safeStorage\(/g) || []).length === 2, 'browser storage is only reached through the try/catch wrapper');

// ---------------------------------------------------------------- offline
section('Offline: no external references');
const shipped = ['index.html', 'config.js', ...cssFiles, ...jsFiles, 'i18n/en.json', 'i18n/fr.json'];
const ALLOWED = new Set(['http://www.w3.org/2000/svg']);
const external = [];
for (const f of shipped) {
  const src = read(f);
  for (const m of src.matchAll(/https?:\/\/[^\s"'<>)\\]+/g)) if (!ALLOWED.has(m[0])) external.push(f + ': ' + m[0]);
  for (const m of src.matchAll(/["'(=]\s*\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/gi)) external.push(f + ': protocol-relative ' + m[0]);
}
check(external.length === 0, 'no http:// or https:// URL in any shipped file (' + shipped.length + ' files; the SVG namespace string is the only exception)', external.join(', '));
// ---- sub-path safety: the page must work under /<repo>/ on a project site
const rooted = [];
for (const n of nodes) for (const a of ['href', 'src', 'action', 'poster', 'data']) if (n.attrs[a] && n.attrs[a].startsWith('/')) rooted.push('index.html ' + a + '=' + n.attrs[a]);
for (const f of ['config.js', ...jsFiles, ...cssFiles]) {
  const src = read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // (a literal appended to an absolute API address, as in apiBase + '/api', is not a rooted URL)
  for (const m of src.matchAll(/(?<!\+\s)['"`(]\/(?:api|fixtures|i18n|js|css|config)\b[^'"`)]*/g)) rooted.push(f + ': ' + m[0]);
  for (const m of src.matchAll(/\bfrom\s+['"]\/[^'"]*/g)) rooted.push(f + ': ' + m[0]);
}
check(rooted.length === 0, 'no URL starts at the domain root: every asset, module, fixture and API path is relative (works under a sub-path)', rooted.join(', '));
check(!nodes.some((n) => n.tag === 'base'), 'no <base> element (relative URLs resolve against the page itself)');
const cspNode = nodes.find((n) => n.tag === 'meta' && n.attrs['http-equiv'] === 'Content-Security-Policy');
check(cspNode && /(^|; )connect-src 'self'(;|$)/.test(cspNode.attrs.content) && !/\*/.test(cspNode.attrs.content), "Content-Security-Policy has connect-src 'self' and no wildcard (the Pages build adds the one API origin)");
const cfgModule = (await import(pathToFileURL(path.join(web, 'config.js')).href)).default;
check(cfgModule.apiBase === '' && cfgModule.demoOnly === false && Array.isArray(cfgModule.apiAlternatives) && cfgModule.apiAlternatives.length === 0, 'config.js in the repository is the same-origin default (empty apiBase, no alternatives, not demo-only)');

const css = cssFiles.map(read).join('\n');
check(!/@font-face|@import|url\(/.test(css), 'CSS loads no fonts, imports or images');
check(/font:\s*1rem\/[\d.]+ var\(--font\)/.test(css) && /--font:\s*system-ui/.test(css), 'system font stack only');
check(!/gradient\(/.test(css), 'no gradients');
const emoji = shipped.filter((f) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(read(f)));
check(emoji.length === 0, 'no emoji in shipped files', emoji.join(', '));
const vendor = fs.existsSync(path.join(web, 'vendor')) ? fs.readdirSync(path.join(web, 'vendor')) : [];
check(vendor.length === 0, 'no third-party code is shipped (web/vendor is absent or empty)');
const images = [];
(function scan(dir) {
  for (const e of fs.readdirSync(path.join(web, dir), { withFileTypes: true })) {
    const rel = dir ? dir + '/' + e.name : e.name;
    if (e.isDirectory()) scan(rel);
    else if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|svg)$/i.test(e.name)) images.push(rel + ' (' + fs.statSync(path.join(web, rel)).size + ' bytes)');
  }
})('');
check(images.length === 0, 'no image or font files at all (limit was 5 KB per image)', images.join(', '));

// ---------------------------------------------------------------- CSS hygiene
section('CSS');
const physical = [...css.matchAll(/(?:^|[;{\s])((?:margin|padding|border)-(?:left|right)(?:-[a-z]+)?|(?<!-)left|(?<!-)right)\s*:/gm)].map((m) => m[1]);
check(physical.length === 0, 'layout uses logical properties only (safe for right-to-left)', [...new Set(physical)].join(', '));
const ta = [...css.matchAll(/text-align:\s*(left|right)/g)];
check(ta.length <= 1, 'text-align left/right appears only for the fixed-layout file example (' + ta.length + ')');
check(/prefers-reduced-motion:\s*reduce/.test(css), 'respects prefers-reduced-motion');
check(/prefers-color-scheme:\s*dark/.test(css), 'has a dark colour set that follows the system preference');
check(/:focus-visible\s*\{[^}]*outline:\s*3px/.test(css), 'visible focus outline defined');
check(/forced-colors:\s*active/.test(css), 'has forced-colours (high contrast) adjustments');
check(/@media print/.test(css), 'has a print style');
const classesUsed = new Set();
for (const n of nodes) for (const c of (n.attrs.class || '').split(/\s+/)) if (c) classesUsed.add(c);
for (const f of jsFiles) for (const m of read(f).matchAll(/class(?:Name)?['"]?\s*[:=,]\s*'([^']+)'/g)) for (const c of m[1].split(/\s+/)) if (c && !c.endsWith('-')) classesUsed.add(c);
const classesDefined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const undefinedClasses = [...classesUsed].filter((c) => !classesDefined.has(c) && !/^(ch-|tone-$|cell-$|sev-$|status-$|verdict-$|conn-$)/.test(c));
if (undefinedClasses.length) info('classes used in markup without a CSS rule (harmless hooks): ' + undefinedClasses.sort().join(', '));

console.log('\n' + (failures ? failures + ' static check(s) FAILED' : 'All static checks passed'));
process.exit(failures ? 1 : 0);
