(function () {
    'use strict';

    // Idempotency guard: fee[dB]ack can re-evaluate a plugin's screen.js
    // (loader cache miss / desktop hot reload). Without this, every reload
    // stacks another MutationObserver and capture-phase 'play' listener and
    // leaks an orphaned <audio> element. Install the page-level hooks exactly
    // once — the first evaluation stays authoritative.
    if (window.__slopsmithSongPreviewHooksInstalled) return;
    window.__slopsmithSongPreviewHooksInstalled = true;

    const PLUGIN = 'song_preview';
    const API = `/api/plugins/${PLUGIN}`;
    const JS_URL = `${API}/js`;

    // Plugin version, stamped onto the [data-song-preview-version] placeholders
    // in the plugin screen header and the Settings section. Sourced once from
    // /api/plugins — the manifest version the host already surfaces (the same
    // place the v3 Plugins page reads it) — so it never drifts from plugin.json.
    // Best-effort: if the fetch fails the placeholders just stay empty.
    let pluginVersion = null;
    const stampVersion = () => {
        if (!pluginVersion) return;
        const text = `v${pluginVersion}`;
        for (const el of document.querySelectorAll('[data-song-preview-version]')) {
            if (el.textContent !== text) el.textContent = text;
        }
    };
    fetch('/api/plugins')
        .then(r => (r.ok ? r.json() : null))
        .then(list => {
            const arr = Array.isArray(list) ? list : (list && list.plugins) || [];
            const entry = arr.find(p => p && p.id === PLUGIN);
            if (entry && entry.version) { pluginVersion = entry.version; stampVersion(); }
        })
        .catch(() => { /* version stamp is best-effort */ });

    // fee[dB]ack loads exactly one script per plugin (manifest's `script`
    // field). routes.py serves the rest of the source as static files
    // under /js/, and we pull them in via dynamic import here.
    const modules = [
        'preview-toggle',
        'menu-gate',
        'input-tracker',
        'audio-controller',
        'progress-scope',
        'preview-loop',
        'preview-backfill',
        'preview-volume',
        'touch-trigger',
        'mutation-guard',
    ];

    Promise.all(modules.map(name => import(`${JS_URL}/${name}.js`)))
        .then(([
            { PreviewToggle },
            { MenuGate },
            { InputTracker },
            { AudioController },
            { ProgressScope },
            { PreviewLoop },
            { PreviewBackfill },
            { PreviewVolume },
            { TouchTrigger },
            { isSelfInflictedMutation },
        ]) => {
            const toggle = new PreviewToggle();
            const menu = new MenuGate();
            const input = new InputTracker();
            const audio = new AudioController({ apiBase: API, pluginName: PLUGIN });
            const scope = new ProgressScope(audio);
            const loop = new PreviewLoop({ toggle, menu, input, audio, scope });
            // Pass audio so PreviewBackfill can flush the 404 memo for
            // files it just fixed, otherwise the hover loop would keep
            // short-circuiting on stale "no preview" state until reload.
            const backfill = new PreviewBackfill({ audio });
            // Owns the preview-volume slider on both surfaces; reads/writes
            // `audio`'s own (decoupled) volume and hides itself when `toggle`
            // is off.
            const volume = new PreviewVolume({ audio, toggle });
            // Touch-only graceful degradation: a tap-to-play button per card
            // where hover can't work. No-op on desktop (gated on a coarse-
            // pointer/no-hover media query). Reuses audio + the same gates.
            const touch = new TouchTrigger({ audio, toggle, menu });

            // Per-DOM-tick bindings. The library re-renders often — coalesce
            // to one inject call per frame.
            let injectPending = false;
            const injectAll = () => {
                toggle.bindDom();
                volume.bindDom();
                menu.bindDom();
                // Settings block lives in a screen that mounts/unmounts on
                // navigation; bindSettings is idempotent (dataset guard).
                backfill.bindSettings();
                // Card badges piggy-back on the existing MutationObserver
                // tick — re-running on every DOM mutation keeps badges in
                // sync with infinite-scroll appends and tree expansions.
                backfill.decorate();
                // Touch play buttons ride the same tick for the same reason:
                // stay in sync with infinite-scroll appends / re-renders.
                touch.decorate();
                // Re-apply the version stamp so it lands whenever the screen or
                // Settings section (re)mounts. Idempotent + cheap.
                stampVersion();
            };
            const scheduleInject = () => {
                if (injectPending) return;
                injectPending = true;
                requestAnimationFrame(() => {
                    injectPending = false;
                    injectAll();
                });
            };

            const obs = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type !== 'childList' || (!m.addedNodes.length && !m.removedNodes.length)) {
                        continue;
                    }
                    // Our own decorators (Fix badges, touch buttons, progress
                    // ring) append/remove nodes INSIDE these observed card
                    // containers. Reacting to those mutations schedules
                    // another injectAll, whose decorators mutate again — a
                    // per-frame observer→inject→observer feedback loop while
                    // the windowed grid recycles cards on every scroll frame.
                    // Records that only touch plugin-owned nodes are ours;
                    // skip them. Host mutations always get through (any
                    // non-owned node in the record disqualifies the skip).
                    if (isSelfInflictedMutation(m)) continue;
                    // Caches may now point at detached nodes — invalidate
                    // synchronously before the next rAF tick reads them.
                    // Inject is coalesced separately.
                    loop.invalidateCursorCache();
                    menu.invalidateCache();
                    scheduleInject();
                    return;
                }
            });
            // Narrow the observer to the card-bearing containers instead of
            // `body, subtree:true`. The browser's subtree tracking is the
            // expensive part (it has to register every descendant); limiting
            // it to the four grids/trees the library actually re-renders
            // keeps the cost where the mutations are.
            //
            // body itself is still observed with subtree:false to catch
            // screen-level mount/unmount events (settings page, plugin
            // screens) — those happen as direct children of body and are
            // rare enough that a shallow observer is essentially free.
            //
            // `v3-songs` / `v3-home` are the v0.3.0 ("fee[dB]ack") Songs and
            // dashboard screen wrappers. Both exist in static/v3/index.html from
            // boot (even before their contents render), and every card mutation
            // — the lazy first render, infinite-scroll appends, dashboard widget
            // re-renders — happens inside them, so observing them subtree:true
            // keeps the per-tick inject (Fix badges + touch buttons) in sync.
            // Absent on a v2 host, so harmless.
            const cardContainers = ['lib-grid', 'lib-tree', 'fav-grid', 'fav-tree', 'v3-songs', 'v3-home']
                .map(id => document.getElementById(id))
                .filter(Boolean);
            if (cardContainers.length) {
                for (const el of cardContainers) {
                    obs.observe(el, { childList: true, subtree: true });
                }
                obs.observe(document.body, { childList: true, subtree: false });
            } else {
                // Fallback: containers not yet rendered (plugin loaded before
                // the library HTML). Fall back to the old wide scope.
                obs.observe(document.body, { childList: true, subtree: true });
            }
            injectAll();
            loop.start();

            // Kick the audit once on plugin init so card badges appear
            // in the library without the user needing to visit settings
            // first. bindSettings()'s own refresh() only fires when the
            // settings DOM is present — necessary for the count UI but
            // useless for cards in the library grid.
            backfill.refresh();

            // Re-audit whenever the user navigates into a library view, so songs
            // added since load — e.g. freshly built/imported in the editor —
            // are picked up (Fix badges, missing-preview list) without a manual
            // library rescan. refresh() is in-flight-guarded, so a per-navigation
            // call is cheap.
            const _LIBRARY_SCREENS = new Set(
                ['home', 'library', 'favorites', 'v3-songs', 'v3-home']);
            const _onScreenChanged = (e) => {
                const id = e && e.detail && e.detail.id;
                if (_LIBRARY_SCREENS.has(id)) backfill.refresh();
            };
            // `library:changed` is emitted when a song is added to the library
            // (e.g. built in the editor) — refresh immediately rather than
            // waiting for the user to navigate. screen:changed above is the
            // fallback for changes that don't emit it (uploads, manual rescans).
            const _onLibraryChanged = () => backfill.refresh();
            if (window.slopsmith && typeof window.slopsmith.on === 'function') {
                window.slopsmith.on('screen:changed', _onScreenChanged);
                window.slopsmith.on('library:changed', _onLibraryChanged);
            }

            // Teardown for when fee[dB]ack unloads the plugin. Reverses
            // everything the idempotency-guarded install set up so a
            // subsequent re-evaluation starts from a clean slate.
            window.__slopsmithSongPreviewTeardown = function teardown() {
                try { obs.disconnect(); } catch (_) {}
                if (window.slopsmith && typeof window.slopsmith.off === 'function') {
                    window.slopsmith.off('screen:changed', _onScreenChanged);
                    window.slopsmith.off('library:changed', _onLibraryChanged);
                }
                loop.destroy();
                scope.destroy();
                audio.destroy();
                input.destroy();
                menu.destroy();
                toggle.destroy();
                backfill.destroy();
                volume.destroy();
                touch.destroy();
                delete window.__slopsmithSongPreviewHooksInstalled;
                delete window.__slopsmithSongPreviewTeardown;
            };
        })
        .catch((err) => {
            console.error(`[${PLUGIN}] module load failed`, err);
            // Release the guard so a future re-evaluation can retry rather
            // than silently no-op'ing forever.
            delete window.__slopsmithSongPreviewHooksInstalled;
        });
})();