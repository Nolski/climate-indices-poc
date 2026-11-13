// Browser storage that never throws. Storage can be missing, full or blocked (private windows,
// locked-down desktops), so every access is wrapped and the app works without it.

const SESSION_KEY = 'climpoc.session.v1';
const RESULT_KEY = 'climpoc.result.v1';
const INDICES_KEY = 'climpoc.indices.v1';
const LANG_KEY = 'climpoc.lang';
const MAX_RESULT_CHARS = 1500000;

export function safeStorage(getStore) {
  const store = () => {
    try {
      return getStore();
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      try {
        const s = store();
        const raw = s ? s.getItem(key) : null;
        return raw == null ? null : JSON.parse(raw);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        const s = store();
        if (!s) return false;
        s.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        const s = store();
        if (s) s.removeItem(key);
      } catch {
        /* nothing to do */
      }
    },
  };
}

export function createStore(session, local) {
  // A demonstration session is kept apart from a real one, so falling back to the demonstration
  // while the server is away never overwrites (or impersonates) the session with real data.
  let suffix = '';
  const SESSION = () => SESSION_KEY + suffix;
  const RESULT = () => RESULT_KEY + suffix;
  return {
    setMode(demo) {
      suffix = demo ? '.demo' : '';
    },
    loadSession() {
      const s = session.get(SESSION());
      return s && typeof s === 'object' && s.datasetId ? s : null;
    },
    saveSession(state) {
      if (!state.dataset) {
        session.remove(SESSION());
        session.remove(RESULT());
        return;
      }
      session.set(SESSION(), {
        datasetId: state.dataset.id,
        source: state.source,
        fileName: state.fileName,
        settings: state.settings,
        selection: Array.from(state.selection || []),
        selectionTouched: Boolean(state.selectionTouched),
        frequency: state.frequency,
        step: state.step,
        loadedAt: state.loadedAt,
      });
    },
    // Results are kept so a reload on the results page needs no network at all. They are small
    // (tens to a few hundred KB); if they do not fit, the app simply recalculates.
    saveResult(result, computedAt) {
      if (!result) return session.remove(RESULT());
      let text = '';
      try {
        text = JSON.stringify({ result, computedAt });
      } catch {
        return false;
      }
      if (text.length > MAX_RESULT_CHARS) {
        session.remove(RESULT());
        return false;
      }
      return session.set(RESULT(), { result, computedAt });
    },
    loadResult(datasetId) {
      const r = session.get(RESULT());
      return r && r.result && r.result.dataset_id === datasetId ? r : null;
    },
    clearSession() {
      session.remove(SESSION());
      session.remove(RESULT());
    },
    loadIndices() {
      const c = local.get(INDICES_KEY);
      return c && Array.isArray(c.indices) && c.indices.length ? c : null;
    },
    saveIndices(indices, appVersion) {
      local.set(INDICES_KEY, { indices, app: appVersion || '', saved: Date.now() });
    },
    loadLang: () => local.get(LANG_KEY),
    saveLang: (code) => local.set(LANG_KEY, code),
  };
}
