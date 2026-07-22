/**
 * library-client.js
 * Shared lookup + autocomplete client for the My Apps suite.
 *
 * Usage:
 *   <script src="https://my-library-tan.vercel.app/library-client.js"></script>
 *   const result = await LibraryClient.resolveStore('CARREFOUR MARKET');
 *   LibraryClient.attachAutocomplete(inputEl, { type: 'item', onSelect: item => ... });
 */
(function (global) {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const RAW_BASE   = 'https://raw.githubusercontent.com/malliach-wq/my-library/main/data/';
  const LIB_URL    = 'https://my-library-tan.vercel.app/';
  const CACHE_MS   = 5 * 60 * 1000; // 5-minute in-memory cache

  // ── Cache ───────────────────────────────────────────────────────────────────
  let _cache     = null;
  let _loadedAt  = 0;
  let _inflight  = null;

  async function loadLibrary(force) {
    if (!force && _cache && (Date.now() - _loadedAt < CACHE_MS)) return _cache;
    if (_inflight) return _inflight;
    _inflight = Promise.all([
      fetch(RAW_BASE + 'stores.json?t='     + Date.now()).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(RAW_BASE + 'items.json?t='      + Date.now()).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(RAW_BASE + 'currencies.json?t=' + Date.now()).then(r => r.ok ? r.json() : []).catch(() => [])
    ]).then(([stores, items, currencies]) => {
      _cache    = { stores, items, currencies };
      _loadedAt = Date.now();
      _inflight = null;
      return _cache;
    }).catch(err => { _inflight = null; throw err; });
    return _inflight;
  }

  // ── Normalisation ───────────────────────────────────────────────────────────
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Returns 0–100 similarity score between query and a list of candidate strings.
  function scoreMatch(query, candidates) {
    const q = norm(query);
    if (!q) return 0;
    let best = 0;
    for (const c of candidates) {
      const v = norm(c);
      if (!v) continue;
      if (v === q)              { return 100; }
      if (v.startsWith(q))     { best = Math.max(best, 90); }
      if (q.startsWith(v))     { best = Math.max(best, 85); }
      if (v.includes(q))       { best = Math.max(best, 80); }
      if (q.includes(v))       { best = Math.max(best, 75); }
    }
    return best;
  }

  function storeTerms(s) {
    return [s.friendlyName, s.name, ...(s.aliases || [])].filter(Boolean);
  }
  function itemTerms(i) {
    return [i.name, ...(i.aliases || [])].filter(Boolean);
  }
  function currencyTerms(c) {
    return [c.code, c.symbol, c.name].filter(Boolean);
  }

  // ── Resolve — returns best match object or null ──────────────────────────────
  async function resolveStore(text) {
    const { stores } = await loadLibrary();
    let best = null, top = 0;
    for (const s of stores) {
      const sc = scoreMatch(text, storeTerms(s));
      if (sc > top) { top = sc; best = s; }
    }
    return top >= 70 ? { match: best, score: top } : null;
  }

  async function resolveItem(text) {
    const { items } = await loadLibrary();
    let best = null, top = 0;
    for (const i of items) {
      const sc = scoreMatch(text, itemTerms(i));
      if (sc > top) { top = sc; best = i; }
    }
    return top >= 70 ? { match: best, score: top } : null;
  }

  async function resolveCurrency(text) {
    const { currencies } = await loadLibrary();
    const q = norm(text);
    return currencies.find(c => currencyTerms(c).some(t => norm(t) === q)) || null;
  }

  // ── Suggest — returns ranked array for autocomplete dropdowns ────────────────
  async function suggestStores(query, limit) {
    limit = limit || 10;
    const { stores } = await loadLibrary();
    if (!query) return stores.slice(0, limit);
    const q = norm(query);
    return stores
      .map(s => ({ e: s, sc: scoreMatch(query, storeTerms(s)) }))
      .filter(x => x.sc > 0 || storeTerms(x.e).some(t => norm(t).includes(q)))
      .sort((a, b) => b.sc - a.sc)
      .map(x => x.e)
      .slice(0, limit);
  }

  async function suggestItems(query, limit) {
    limit = limit || 10;
    const { items } = await loadLibrary();
    if (!query) return items.slice(0, limit);
    const q = norm(query);
    return items
      .map(i => ({ e: i, sc: scoreMatch(query, itemTerms(i)) }))
      .filter(x => x.sc > 0 || itemTerms(x.e).some(t => norm(t).includes(q)))
      .sort((a, b) => b.sc - a.sc)
      .map(x => x.e)
      .slice(0, limit);
  }

  async function suggestCurrencies(query, limit) {
    limit = limit || 10;
    const { currencies } = await loadLibrary();
    if (!query) return currencies.slice(0, limit);
    const q = norm(query);
    return currencies
      .filter(c => currencyTerms(c).some(t => norm(t).includes(q)))
      .slice(0, limit);
  }

  // ── createAndEditUrl ────────────────────────────────────────────────────────
  // Returns a URL that opens My Library with a pre-filled create modal.
  // type: 'store' | 'item' | 'currency'
  // prefill: { name, friendlyName, aliases, code, symbol, ... }
  function createAndEditUrl(type, prefill) {
    const url = new URL(LIB_URL);
    url.searchParams.set('action', 'create');
    url.searchParams.set('type', type);
    if (prefill) {
      for (const [k, v] of Object.entries(prefill)) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  // ── attachAutocomplete ─────────────────���────────────────────────────────────
  // Wires a live-search dropdown + "Create and Edit" row onto any <input>.
  //
  // options:
  //   type        'store' | 'item' | 'currency'
  //   onSelect    function(entry)  — called when user picks a suggestion
  //   onCreateNew function(text)   — called when "Create and Edit" is clicked
  //                                  (defaults to opening My Library in a new tab)
  //   limit       max suggestions (default 8)
  //   accentColor CSS colour for hover/highlight (default '#5c2d6e')
  //
  // Returns { remove() } to detach the widget.
  function attachAutocomplete(input, options) {
    options = options || {};
    const type    = options.type || 'item';
    const limit   = options.limit || 8;
    const accent  = options.accentColor || '#5c2d6e';
    const accentBg = options.accentBg || '#f3edf7';

    const suggestFn = { store: suggestStores, item: suggestItems, currency: suggestCurrencies }[type];
    const labelFn   = {
      store:    s => s.friendlyName || s.name,
      item:     i => i.name,
      currency: c => c.code + ' (' + c.symbol + ') – ' + c.name
    }[type];

    // Style injection (once per page)
    if (!document.getElementById('_lc_styles')) {
      const st = document.createElement('style');
      st.id = '_lc_styles';
      st.textContent = [
        '._lc_dd{position:absolute;background:#fff;border:1px solid #d0c4e0;border-radius:6px;',
        'box-shadow:0 4px 16px rgba(0,0,0,.13);z-index:99999;max-height:240px;overflow-y:auto;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:.84rem;}',
        '._lc_item{padding:8px 12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '._lc_item:hover,._lc_item.active{background:' + accentBg + ';}',
        '._lc_create{padding:8px 12px;cursor:pointer;font-weight:600;color:' + accent + ';}',
        '._lc_create:hover{background:' + accentBg + ';}',
        '._lc_sep{border:none;border-top:1px solid #ede8f2;margin:0;}'
      ].join('');
      document.head.appendChild(st);
    }

    let dd = null;
    let activeIdx = -1;

    function removeDd() {
      if (dd) { dd.remove(); dd = null; activeIdx = -1; }
    }

    function buildDd(entries, query) {
      removeDd();
      if (!entries.length && !query) return;

      dd = document.createElement('div');
      dd.className = '_lc_dd';

      entries.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = '_lc_item';
        row.textContent = labelFn(entry);
        row.dataset.idx = idx;
        row.addEventListener('mouseenter', () => { activeIdx = idx; highlightActive(); });
        row.addEventListener('mousedown', e => {
          e.preventDefault();
          selectEntry(entry);
        });
        dd.appendChild(row);
      });

      if (query) {
        if (entries.length) {
          const sep = document.createElement('hr');
          sep.className = '_lc_sep';
          dd.appendChild(sep);
        }
        const cr = document.createElement('div');
        cr.className = '_lc_create';
        cr.textContent = '➕ Create and Edit "' + query + '" in Library';
        cr.addEventListener('mousedown', e => {
          e.preventDefault();
          removeDd();
          if (options.onCreateNew) {
            options.onCreateNew(query);
          } else {
            window.open(createAndEditUrl(type, { name: query }), '_blank');
          }
        });
        dd.appendChild(cr);
      }

      positionDd();
      document.body.appendChild(dd);
    }

    function positionDd() {
      if (!dd) return;
      const r = input.getBoundingClientRect();
      dd.style.top    = (r.bottom + window.scrollY + 2) + 'px';
      dd.style.left   = (r.left + window.scrollX) + 'px';
      dd.style.minWidth = r.width + 'px';
    }

    function highlightActive() {
      if (!dd) return;
      dd.querySelectorAll('._lc_item').forEach((el, i) => {
        el.classList.toggle('active', i === activeIdx);
      });
    }

    function selectEntry(entry) {
      input.value = labelFn(entry);
      removeDd();
      if (options.onSelect) options.onSelect(entry);
    }

    async function refresh() {
      const q = input.value.trim();
      const results = await suggestFn(q, limit);
      buildDd(results, q);
    }

    // ── Event listeners ──────────────────────────────────────────────────────
    input.addEventListener('input',  refresh);
    input.addEventListener('focus',  refresh);
    input.addEventListener('blur',   () => setTimeout(removeDd, 160));

    input.addEventListener('keydown', e => {
      if (!dd) return;
      const items = dd.querySelectorAll('._lc_item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        highlightActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(bctiveIdx - 1, 0);
        highlightActive();
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault();
        items[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
      } else if (e.key === 'Escape') {
        removeDd();
      }
    });

    window.addEventListener('resize', positionDd);

    return { remove: () => { removeDd(); } };
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  global.LibraryClient = {
    load:              loadLibrary,
    resolveStore:      resolveStore,
    resolveItem:       resolveItem,
    resolveCurrency:   resolveCurrency,
    suggestStores:     suggestStores,
    suggestItems:      suggestItems,
    suggestCurrencies: suggestCurrencies,
    createAndEditUrl:  createAndEditUrl,
    attachAutocomplete: attachAutocomplete
  };

})(window);
