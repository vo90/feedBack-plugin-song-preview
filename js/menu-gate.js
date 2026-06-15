// Tracks whether any host UI overlay is "open enough" that we should
// suppress previews. Native <select>s don't expose an "options list is
// showing" state to JS, so we approximate it via mousedown/change/blur
// per gated id. Using :focus would latch forever (the browser keeps
// focus on a select after a pick).
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
        // v3 per-card "⋮" action menu — transient, class-based (no stable id),
        // so a direct query rather than the cached id map.
        if (document.querySelector('.v3-card-menu')) return true;
        return false;
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
    }
}
