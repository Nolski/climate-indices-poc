// Tiny translation helper. All user-facing text lives in web/i18n/<lang>.json as a flat
// key -> string map. Placeholders are written {like_this}. Plurals use two keys, "<key>.one"
// and "<key>.other" (plus any other Intl.PluralRules category a language needs).

export const LANGUAGES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'fr', label: 'Français', dir: 'ltr', draft: true },
];

export const DEFAULT_LANGUAGE = 'en';

export function pickLanguage(candidates, supported = LANGUAGES.map((l) => l.code)) {
  for (const c of candidates) {
    if (!c) continue;
    const code = String(c).toLowerCase();
    if (supported.includes(code)) return code;
    const short = code.split('-')[0];
    if (supported.includes(short)) return short;
  }
  return DEFAULT_LANGUAGE;
}

export function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined || params[name] === null ? whole : String(params[name])));
}

export function createI18n({ loadJson, fallback = DEFAULT_LANGUAGE } = {}) {
  const tables = new Map();
  let lang = fallback;
  let rules = null;

  async function load(code) {
    if (!tables.has(code)) tables.set(code, await loadJson('i18n/' + code + '.json'));
    return tables.get(code);
  }

  function lookup(key) {
    const own = tables.get(lang);
    if (own && typeof own[key] === 'string') return own[key];
    const fb = tables.get(fallback);
    if (fb && typeof fb[key] === 'string') return fb[key];
    return null;
  }

  function t(key, params) {
    const s = lookup(key);
    return s === null ? key : interpolate(s, params);
  }

  // Plural-aware: tn('qc.records', 3) uses "qc.records.other" and fills {n}.
  function tn(key, n, params) {
    let cat = 'other';
    try {
      if (!rules) rules = new Intl.PluralRules(lang);
      cat = rules.select(n);
    } catch {
      cat = n === 1 ? 'one' : 'other';
    }
    const s = lookup(key + '.' + cat) ?? lookup(key + '.other');
    return s === null ? key : interpolate(s, { n, ...params });
  }

  return {
    t,
    tn,
    has: (key) => lookup(key) !== null,
    get lang() {
      return lang;
    },
    get dir() {
      const l = LANGUAGES.find((x) => x.code === lang);
      return l ? l.dir : 'ltr';
    },
    get draft() {
      const l = LANGUAGES.find((x) => x.code === lang);
      return Boolean(l && l.draft);
    },
    // Loads the fallback first so a missing key in a draft translation still shows English.
    async use(code) {
      if (!tables.has(fallback)) await load(fallback);
      if (code !== fallback) {
        try {
          await load(code);
        } catch (e) {
          if (!tables.has(fallback)) throw e;
          code = fallback;
        }
      }
      lang = code;
      rules = null;
      return lang;
    },
    // Fills static markup: data-i18n="key" sets text, data-i18n-attr="attr:key;attr2:key2" sets attributes.
    apply(root) {
      for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
      for (const el of root.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
          const [attr, key] = pair.split(':').map((s) => s.trim());
          if (attr && key) el.setAttribute(attr, t(key));
        }
      }
    },
  };
}
