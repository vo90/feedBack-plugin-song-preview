// Tracks whether any host UI overlay is "open enough" that we should
// suppress previews. Native <select>s don't expose an "options list is
// showing" state to JS, so we approximate it via mousedown/change/blur
// per gated id. Using :focus would latch forever (the browser keeps
// focus on a select after a pick).

// The v3 per-card "⋮" action menu. Class-based (transient, no stable id).
const CARD_MENU_CLASS = 'v3-card-menu';

export class MenuGate {
    constructor() {
        // v2 library/favorites selects, plus the v0.3.0 ("fee[dB]ack") Songs
        // screen's provider/sort/format selects.
        this.GATED_SELECT_IDS = [
            'lib-format', 'lib-sort', 'fav-sort',
            'v3-songs-provider', 'v3-songs-sort', 'v3-songs-format',
        ];
        this._openSelectIds = new Set();
        this._handlers = new WeakMap();

        // getElementById is cheap but isAnyMenuOpen is called every rAF
        // tick (~60/sec), so each lookup per tick adds up when idle.
        // Cache element refs and invalidate when the DOM mutates (the
        // bootstrap's MutationObserver calls invalidateCache()).
        // `v3-songs-overlay` is the dimmer behind the v3 Songs filter drawer
        // (shown together with it).
        this._WATCHED_IDS = ['plugin-dropdown', 'lib-filter-drawer', 'tuner-plugin-ui', 'v3-songs-overlay'];
        this._cachedEls = null;

        // The currently-open v3 card menu, tracked by _watchCardMenu's observer
        // instead of being re-queried every tick. Validity is `isConnected`, so
        // a stale ref costs nothing and can't latch the gate open.
        this._cardMenu = null;
        this._cardMenuObserver = null;
    }

    // Called from the bootstrap MutationObserver. Refs may now point at
    // detached nodes (replaced by a re-render) — re-query on next read.
    invalidateCache() {
        this._cachedEls = null;
    }

    _resolveEls() {
        if (this._cachedEls) return this._cachedEls;
        const els = {};
        for (const id of this._WATCHED_IDS) {
            els[id] = document.getElementById(id);
        }
        this._cachedEls = els;
        return els;
    }

    // Idempotent — safe to call on every DOM mutation tick. Selects come
    // and go as the library re-renders.
    bindDom() {
        for (const id of this.GATED_SELECT_IDS) {
            const el = document.getElementById(id);
            if (!el || el.dataset.songPreviewSelectGate) continue;
            el.dataset.songPreviewSelectGate = '1';
            const onDown = () => this._openSelectIds.add(id);
            const onChange = () => this._openSelectIds.delete(id);
            const onBlur = () => this._openSelectIds.delete(id);
            this._handlers.set(el, { onDown, onChange, onBlur });
            el.addEventListener('mousedown', onDown);
            el.addEventListener('change', onChange);
            el.addEventListener('blur', onBlur);
        }
    }

    isAnyMenuOpen() {
        const els = this._resolveEls();
        const pluginDD = els['plugin-dropdown'];
        if (pluginDD && !pluginDD.classList.contains('hidden')) return true;
        const filtersDrawer = els['lib-filter-drawer'];
        if (filtersDrawer && filtersDrawer.classList.contains('open')) return true;
        if (this._openSelectIds.size > 0) return true;
        const tuner = els['tuner-plugin-ui'];
        if (tuner && !tuner.classList.contains('hidden')) return true;
        // v3 Songs filter drawer: its overlay is only in the DOM (un-hidden)
        // while the drawer is open.
        const v3Overlay = els['v3-songs-overlay'];
        if (v3Overlay && !v3Overlay.classList.contains('hidden')) return true;
        // v3 per-card "⋮" action menu — transient, class-based (no stable id).
        // Tracked by an observer rather than queried; see _watchCardMenu.
        this._watchCardMenu();
        if (this._cardMenu && this._cardMenu.isConnected) return true;
        return false;
    }

    // The card menu used to be found with a bare
    // `document.querySelector('.v3-card-menu')` right here, on every rAF tick.
    // A class selector that MISSES — the normal case, no menu open — cannot
    // short-circuit: it walks the whole document before returning null. The
    // Songs screen renders one card per song, so on a large library that single
    // line walked an enormous tree 60x/sec. Measured on a 50,944-song library:
    // ~50% of the entire renderer CPU, 2 fps in the venue highway
    // (feedBack-desktop). It scales with library size, which is why it only
    // bites big collections and looks fine in dev.
    //
    // Track the node instead. The observer fires only when the DOM actually
    // changes, and inspects just the changed nodes — never the whole tree. The
    // per-tick read is then `isConnected`, which is O(1) and also goes false for
    // free when the menu (or the card it lives in) is detached, so a menu torn
    // down by a re-render can't latch the gate open.
    _watchCardMenu() {
        if (this._cardMenuObserver) return;
        const find = (n) => {
            if (!n || n.nodeType !== 1) return null;
            if (n.classList && n.classList.contains(CARD_MENU_CLASS)) return n;
            // Defensive: songs.js appends the menu directly, so it IS the added
            // node — but a future wrapper shouldn't silently disable the gate.
            // Scoped to the added subtree, never the document.
            return n.querySelector ? n.querySelector('.' + CARD_MENU_CLASS) : null;
        };
        this._cardMenuObserver = new MutationObserver((records) => {
            for (const r of records) {
                for (const n of r.addedNodes) {
                    const menu = find(n);
                    if (menu) this._cardMenu = menu;
                }
            }
        });
        this._cardMenuObserver.observe(document.body, { childList: true, subtree: true });
        // A menu already open when the gate first runs (we start lazily).
        this._cardMenu = document.querySelector('.' + CARD_MENU_CLASS);
    }

    destroy() {
        for (const id of this.GATED_SELECT_IDS) {
            const el = document.getElementById(id);
            if (!el) continue;
            const h = this._handlers.get(el);
            if (h) {
                el.removeEventListener('mousedown', h.onDown);
                el.removeEventListener('change', h.onChange);
                el.removeEventListener('blur', h.onBlur);
            }
            delete el.dataset.songPreviewSelectGate;
        }
        this._openSelectIds.clear();
        if (this._cardMenuObserver) {
            this._cardMenuObserver.disconnect();
            this._cardMenuObserver = null;
        }
        this._cardMenu = null;
    }
}
