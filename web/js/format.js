// Number, date and unit formatting through Intl, for the current language.

export function createFormat(lang, t, has) {
  const nfCache = new Map();
  const nf = (opts) => {
    const key = JSON.stringify(opts);
    if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat(lang, opts));
    return nfCache.get(key);
  };
  const fix = (v) => (Object.is(v, -0) || Math.abs(v) < 1e-12 ? 0 : v);
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);

  const dateMedium = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' });
  const monthYear = new Intl.DateTimeFormat(lang, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const dayMonth = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const clock = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' });
  const dateTime = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' });

  const api = {
    // Plain number with up to `max` decimals.
    num(v, max = 1, min = 0) {
      if (!ok(v)) return t('common.noValue');
      return nf({ maximumFractionDigits: max, minimumFractionDigits: Math.min(min, max) }).format(fix(v));
    },
    int(v) {
      if (!ok(v)) return t('common.noValue');
      return nf({ maximumFractionDigits: 0 }).format(fix(v));
    },
    // About two significant digits: right for a trend, where 5.1515 is false precision.
    sig(v, digits = 2) {
      if (!ok(v)) return t('common.noValue');
      return nf({ maximumSignificantDigits: digits }).format(fix(v));
    },
    signed(v, digits = 2) {
      if (!ok(v)) return t('common.noValue');
      return nf({ maximumSignificantDigits: digits, signDisplay: 'exceptZero' }).format(fix(v));
    },
    percent(fraction, max = 1) {
      if (!ok(fraction)) return t('common.noValue');
      return nf({ style: 'percent', maximumFractionDigits: max }).format(fraction);
    },
    pValue(p) {
      if (!ok(p)) return t('common.noValue');
      if (p < 0.001) return t('trend.pBelow', { value: nf({ minimumFractionDigits: 3 }).format(0.001) });
      return t('trend.pEquals', { value: nf({ maximumFractionDigits: p < 0.01 ? 3 : 2, minimumFractionDigits: 2 }).format(p) });
    },
    date(iso) {
      const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
      return Number.isNaN(d.getTime()) ? String(iso) : dateMedium.format(d);
    },
    // "1936" stays "1936" (a year must never get a thousands separator); "1936-02" -> "Feb 1936".
    timeKey(key) {
      const s = String(key);
      if (s.length < 7) return s;
      const d = new Date(s.slice(0, 7) + '-01T00:00:00Z');
      return Number.isNaN(d.getTime()) ? s : monthYear.format(d);
    },
    tick(tk) {
      if (tk.level === 'year') return String(tk.y);
      const d = new Date(Date.UTC(tk.y, tk.m - 1, tk.d || 1));
      return tk.level === 'month' ? monthYear.format(d) : dayMonth.format(d);
    },
    clock: (date) => clock.format(date),
    dateTime: (date) => dateTime.format(date),
    bytes(n) {
      if (!ok(n)) return '';
      if (n < 1024) return t('size.bytes', { n: api.int(n) });
      if (n < 1024 * 1024) return t('size.kb', { n: api.num(n / 1024, n < 10240 ? 1 : 0) });
      return t('size.mb', { n: api.num(n / 1024 / 1024, 1) });
    },
    seconds(ms) {
      return t('time.seconds', { n: api.num(ms / 1000, ms < 10000 ? 1 : 0) });
    },
    // "degC" -> "°C" and so on; unknown units are shown as the server sent them.
    unit(u) {
      const key = 'unit.' + u;
      return u && has(key) ? t(key) : u || '';
    },
    // The unit to use after "per decade": percentages become percentage points.
    unitChange(u) {
      const key = 'unitChange.' + u;
      return u && has(key) ? t(key) : api.unit(u);
    },
    variable(v) {
      const key = 'var.' + v;
      return has(key) ? t(key) : v;
    },
  };
  return api;
}
