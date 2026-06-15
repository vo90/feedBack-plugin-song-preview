// Touch-device preview trigger. The hover loop (PreviewLoop) is the primary
// modality and is built on two things a touchscreen doesn't have: a persistent
// pointer (start = elementFromPoint) and a "cursor left the card" signal
// (stop). Long-press is unusable too — the browser claims it for the
// context/selection menu. So on touch we don't try to patch hover; we add an
// explicit affordance: a tap-to-play / tap-to-stop button per card/row.
//
// This is graceful degradation, not a parallel UX — desktop is left completely
// untouched. We only inject anything when the device reports no hover + a
// coarse pointer, and everything below the trigger is reused: AudioController
// owns playback (start/stop, handoff, the 404 memo), and ProgressScope draws
// its ring off the same 'play'/'stop' events, so the clip looks identical to a
// hover-triggered one.
//
// Two deliberate details that mirror PreviewBackfill:
//   - One document-level click delegate, not per-button handlers — survives
//     the library re-rendering card innerHTML out from under us.
//   - State changes (idle ↔ playing) toggle a CLASS, never innerHTML. The
//     bootstrap MutationObserver watches childList only, so an attribute flip
//     is invisible to it; an innerHTML rewrite inside an observed card grid
//     would re-trigger the observer → re-decorate → rewrite, a per-frame loop.

import { previewableFrom, readFilename, artElement, isGridCard, isV3Card, isDashboardHero, allPreviewableNodes, dashboardPreviewableNodes } from './host-adapter.js';

const STYLE_ID = 'song-preview-touch-styles';
// Dataset key marking nodes we've injected a play button into. Value is the
// filename, so a recycled card node (infinite scroll re-uses DOM) whose
// data-play changed underneath us is detected and re-wired.
const FLAG = 'songPreviewTouchBtn';

// Self-contained styles — the host ships a purged, prebuilt tailwind.min.css
// that doesn't include plugin-only classes, so anything that must render is
// scoped here rather than leaning on host utilities. Accent matches the host
// the same way style.css does: --sm-accent triplet with the literal #4080e0
// fallback.
const STYLES = `
.sp-touch-play{
    position:absolute;right:8px;bottom:8px;z-index:3;
    /* 44x44 minimum touch target (Apple HIG / WCAG 2.5.5). */
    width:44px;height:44px;display:flex;align-items:center;justify-content:center;
    padding:0;border:none;border-radius:9999px;cursor:pointer;
    color:#fff;background:rgba(0,0,0,.55);
    -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);
    box-shadow:0 1px 3px rgba(0,0,0,.5);
    transition:background-color 150ms ease,transform 100ms ease;
    touch-action:manipulation;-webkit-tap-highlight-color:transparent;
}
.sp-touch-play:active{transform:scale(.92)}
.sp-touch-play.is-playing{background:rgb(var(--sm-accent, 64, 128, 224))}
.sp-touch-play svg{width:20px;height:20px;display:block;pointer-events:none}
.sp-touch-play .sp-ico-stop{display:none}
.sp-touch-play.is-playing .sp-ico-play{display:none}
.sp-touch-play.is-playing .sp-ico-stop{display:block}
/* Row variant: no album art to overlay, so sit inline beside the title.
   Keep the full 44px hit target. */
.sp-touch-play--row{
    position:static;width:44px;height:44px;margin-left:8px;flex:0 0 auto;
}
.sp-touch-play--row svg{width:18px;height:18px}
/* Compact size, shared by the dashboard tiles and the v3 Songs grid cards so
   the play button looks identical across both. */
.sp-touch-play--sm{width:32px;height:32px}
.sp-touch-play--sm svg{width:15px;height:15px}
/* Top-left placement for the dashboard "Jump back in!" tiles, whose accuracy /
   format badges sit along the BOTTOM — keep clear of them. (Songs grid cards
   keep the default bottom-right corner; their top-left holds the tuning chip.) */
.sp-touch-play--corner{left:6px;top:6px;right:auto;bottom:auto}
/* Enlarged tap target around the host's existing ▶ glyph on the Continue/Pick
   hero card, which we hijack as the preview toggle. Padding grows the hit area;
   the matching negative margin keeps the glyph's visual position unchanged. */
.sp-hero-glyph{
    cursor:pointer;padding:10px;margin:-10px;
    -webkit-tap-highlight-color:transparent;touch-action:manipulation;
}
`;

// Play triangle + stop square, both present in the DOM so the visible one is a
// pure CSS toggle (see the class-not-innerHTML note above).
const ICONS =
    '<svg class="sp-ico-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>' +
    '<svg class="sp-ico-stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';

export class TouchTrigger {
    constructor({ audio, toggle, menu }) {
        this._audio = audio;
        this._toggle = toggle;
        this._menu = menu;

        // The whole feature is gated on this. Pure touch devices only — a
        // mouse user on a hybrid 2-in-1 keeps the hover path untouched.
        this._mql = window.matchMedia('(hover: none) and (pointer: coarse)');
        this._isTouch = this._mql.matches;
        // Devices rarely flip modality, but a 2-in-1 detaching its keyboard
        // can. React so buttons appear/disappear without a reload.
        this._onMqlChange = (e) => {
            this._isTouch = e.matches;
            if (this._isTouch) this.decorate();
            else this._removeAll();
        };
        // addEventListener('change') is the modern API; addListener is the
        // deprecated fallback some embedded webviews still ship.
        if (this._mql.addEventListener) this._mql.addEventListener('change', this._onMqlChange);
        else if (this._mql.addListener) this._mql.addListener(this._onMqlChange);

        if (this._isTouch) this._ensureStyles();

        // Keep every visible button's icon in sync with actual playback,
        // whatever started it. Cheap: only fires on play/stop transitions,
        // not per frame.
        this._onPlay = (file) => this._syncButtons(file);
        this._onStop = () => this._syncButtons(null);
        audio.on('play', this._onPlay);
        audio.on('stop', this._onStop);

        // One delegate for every button across every card/row — same reason
        // PreviewBackfill uses one: per-button handlers get orphaned when the
        // library rebuilds a container's innerHTML mid-interaction.
        //
        // We act on `pointerup`, not `click`: the v3 cards reveal controls on
        // hover (`group-hover`), and a touchscreen turns the FIRST tap of a
        // hover element into a "hover" — the click only arrives on the second
        // tap. Handling pointerup makes a single tap fire the preview, and we
        // then swallow the follow-up click so it doesn't toggle straight back
        // off. Both listen in the CAPTURE phase so we beat the host's own play
        // handler (in v3 it's bound on the `[data-v3-play]` square / the card
        // <button> our control sits inside — bubble-phase would be too late).
        this._suppressNextClick = false;
        this._onPointerUp = (e) => {
            const btn = e.target.closest('[data-song-preview-play]');
            if (!btn) return;
            e.stopPropagation();
            e.preventDefault();
            this._suppressNextClick = true;
            this._handleTap(btn);
        };
        this._onClick = (e) => {
            const btn = e.target.closest('[data-song-preview-play]');
            if (!btn) return;
            e.stopPropagation();
            e.preventDefault();
            // pointerup already handled this tap — just absorb the ghost click.
            if (this._suppressNextClick) { this._suppressNextClick = false; return; }
            this._handleTap(btn);
        };
        document.addEventListener('pointerup', this._onPointerUp, true);
        document.addEventListener('click', this._onClick, true);

        // On touch, PreviewLoop stands down, so nothing notices when the
        // playing song scrolls off-screen — the preview would keep going
        // after its card is gone. Stop it once the card scrolls fully out of
        // the viewport: the touch analogue of the cursor leaving a card.
        // Capture-phase + passive catches scrolls inside any inner container
        // (scroll doesn't bubble); rAF-coalesced so we hit-test at most once
        // per frame regardless of how fast scroll events fire.
        this._scrollRaf = 0;
        this._onScroll = () => {
            if (this._scrollRaf) return;
            this._scrollRaf = requestAnimationFrame(() => {
                this._scrollRaf = 0;
                this._stopIfScrolledAway();
            });
        };
        document.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
    }

    // Stop playback once the playing card has scrolled fully out of view.
    // Touch only — on desktop the hover loop owns this. Reads the live file
    // from AudioController (covers the loading phase too) and re-queries the
    // card by filename each time, so a library re-render (fresh node) or a
    // virtualised-out card is handled.
    _stopIfScrolledAway() {
        if (!this._isTouch) return;
        const file = this._audio.currentFile();
        if (!file) return;
        let card = null;
        for (const b of document.querySelectorAll('[data-song-preview-play]')) {
            if (b.getAttribute('data-song-preview-play') === file) {
                card = previewableFrom(b);
                break;
            }
        }
        // Gone from the DOM (virtualised out), or scrolled past the top/bottom
        // edge of the viewport → the song is no longer on screen; stop.
        if (!card) { this._audio.stop('scrolled-away'); return; }
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const r = card.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= vh) this._audio.stop('scrolled-away');
    }

    _ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = STYLES;
        document.head.appendChild(el);
    }

    _handleTap(btn) {
        // Master switch and overlay gates. Buttons aren't injected while the
        // toggle is off, but a tap can still land in the window before a
        // re-decorate removes them — guard here too.
        if (!this._toggle.isEnabled()) return;
        if (this._menu.isAnyMenuOpen()) return;

        const card = previewableFrom(btn);
        const filename = readFilename(card);
        if (!filename) return;

        // Tap the playing card again → stop. Tap a different card → switch
        // (AudioController.start emits 'stop' for the old one, then plays the
        // new). currentFile() covers the loading state too, so a double-tap
        // during load cancels rather than stacking.
        if (this._audio.currentFile() === filename) {
            this._audio.stop('touch-toggle');
        } else {
            this._audio.start(filename, card);
        }
    }

    // Reflect playback state onto buttons by class toggle (attribute write —
    // invisible to the childList MutationObserver). `playingFile` is the
    // decoded filename now playing, or null when nothing is.
    _syncButtons(playingFile) {
        for (const btn of document.querySelectorAll('[data-song-preview-play]')) {
            const fn = btn.getAttribute('data-song-preview-play');
            const on = !!playingFile && fn === playingFile;
            if (btn.dataset.spHijacked !== undefined) {
                // Hijacked host ▶ glyph — swap the glyph instead of the icon CSS.
                this._syncHeroGlyph(btn, on);
            } else {
                btn.classList.toggle('is-playing', on);
                btn.setAttribute('aria-label', on ? 'Stop preview' : 'Play preview');
            }
        }
    }

    // Find the host's play affordance on a hero card: an already-hijacked glyph,
    // else the direct-child <span> whose text is the ▶ play triangle.
    _findHeroGlyph(node) {
        const spans = node.querySelectorAll(':scope > span');
        for (const s of spans) { if (s.dataset.spHijacked !== undefined) return s; }
        for (const s of spans) {
            const t = (s.dataset.spOrig != null ? s.dataset.spOrig : s.textContent).trim();
            if (t === '▶') return s;
        }
        return null;
    }

    // Reflect playback state on the hijacked glyph: ■ while previewing, the
    // original ▶ otherwise. Guarded so it only writes on an actual change (the
    // write is a childList mutation the bootstrap observer would otherwise loop on).
    _syncHeroGlyph(glyph, on) {
        const orig = glyph.dataset.spOrig != null ? glyph.dataset.spOrig : '▶';
        const want = on ? '■' : orig;
        if (glyph.textContent !== want) glyph.textContent = want;
        glyph.setAttribute('aria-label', on ? 'Stop preview' : 'Play preview');
    }

    // Turn the host's existing ▶ glyph into the preview toggle (idempotent).
    _hijackHeroPlay(node, filename, active) {
        const glyph = this._findHeroGlyph(node);
        if (!glyph) return;
        if (glyph.dataset.spHijacked !== filename) {
            if (glyph.dataset.spOrig == null) glyph.dataset.spOrig = glyph.textContent;
            glyph.dataset.spHijacked = filename;
            glyph.setAttribute('data-song-preview-play', filename);
            glyph.setAttribute('role', 'button');
            glyph.classList.add('sp-hero-glyph');
            glyph.tabIndex = -1;
        }
        this._syncHeroGlyph(glyph, filename === active);
    }

    // Undo every hijack — restore the original ▶ text and strip our hooks.
    _restoreHijacked() {
        for (const g of document.querySelectorAll('[data-sp-hijacked]')) {
            if (g.dataset.spOrig != null) g.textContent = g.dataset.spOrig;
            g.classList.remove('sp-hero-glyph');
            g.removeAttribute('data-song-preview-play');
            g.removeAttribute('role');
            g.removeAttribute('aria-label');
            delete g.dataset.spHijacked;
            delete g.dataset.spOrig;
        }
    }

    // Idempotent, called from the bootstrap's per-tick injectAll. Injects a
    // play button into each previewable card/row and removes stale ones. The
    // dataset flag keeps the actual DOM append to once per node, so the
    // re-entrant decorate the append itself triggers is a no-op.
    decorate() {
        if (!this._isTouch) return;
        // Toggled off → tear the buttons down entirely (and stop anything
        // playing). They come back on the next tick once re-enabled.
        if (!this._toggle.isEnabled()) {
            this._removeAll();
            return;
        }
        this._ensureStyles();

        const active = this._audio.currentFile();
        // Library cards/rows (also fed to the Fix-badge decorator) PLUS the v3
        // dashboard tiles (touch-only here — no Fix badge on the dashboard).
        const nodes = [...allPreviewableNodes(), ...dashboardPreviewableNodes()];
        for (const node of nodes) {
            const filename = readFilename(node);
            if (!filename) continue;
            // Hero card (Continue Playing / Pick a song): don't inject our own
            // button — hijack the host's existing ▶ glyph as the preview toggle.
            if (isDashboardHero(node)) {
                this._hijackHeroPlay(node, filename, active);
                continue;
            }
            const current = node.dataset[FLAG];
            if (current === filename) {
                // Same node, same file — just keep the icon honest in case
                // it was injected mid-playback (recycled card).
                const btn = node.querySelector('[data-song-preview-play]');
                if (btn) btn.classList.toggle('is-playing', filename === active);
                continue;
            }
            // New node, or a recycled one whose file changed — re-wire.
            node.querySelector('[data-song-preview-play]')?.remove();
            this._attach(node, filename, filename === active);
            node.dataset[FLAG] = filename;
        }
    }

    _attach(node, filename, playing) {
        const isCard = isGridCard(node);
        const recent = !!(node.hasAttribute && node.hasAttribute('data-recent'));
        const v3 = isV3Card(node);
        // Compact 32px button on every v3 surface (Songs grid cards, the thin v3
        // tree/list rows — a 44px button would be taller than the row — and the
        // dashboard tiles) so it matches across all of them. v2 stays 44px.
        // Dashboard "Jump back in!" tiles also move top-left (`--corner`) to clear
        // their bottom-edge badges; Songs grid cards stay bottom-right (their
        // top-left holds the tuning chip).
        const small = recent || v3;
        const corner = recent;
        // A <span role="button">, NOT a <button>: some hosts (the v3 dashboard
        // recently-played tiles) ARE <button> elements, and a <button> nested
        // inside a <button> is invalid and flaky. A span nests safely everywhere
        // and — being purely class-styled and driven by the document-level
        // pointerup/click delegate — behaves identically. Touch-only, so native
        // button keyboard semantics aren't lost.
        const btn = document.createElement('span');
        btn.setAttribute('role', 'button');
        btn.tabIndex = -1;
        btn.className = 'sp-touch-play'
            + (isCard ? '' : ' sp-touch-play--row')
            + (small ? ' sp-touch-play--sm' : '')
            + (corner ? ' sp-touch-play--corner' : '')
            + (playing ? ' is-playing' : '');
        btn.setAttribute('data-song-preview-play', filename);
        btn.setAttribute('aria-label', playing ? 'Stop preview' : 'Play preview');
        btn.innerHTML = ICONS;
        // Don't let arrow-key library nav walk into the button.
        btn.addEventListener('keydown', (e) => e.stopPropagation());

        if (isCard) {
            // Overlay on the album art (v2 `.card-art` / v3 `[data-v3-play]`
            // square / dashboard tile art), like a typical play button. The
            // ProgressScope ring also lives in that same surface
            // (pointer-events:none), so it draws around the button without
            // intercepting taps.
            const art = artElement(node);
            if (!art) return; // no art surface — skip silently
            if (getComputedStyle(art).position === 'static') art.style.position = 'relative';
            art.appendChild(btn);
        } else {
            // Rows have no art; sit inline beside the existing badges. v2 rows
            // nest title + format in a neutral `.flex-1` container we sit inside.
            // v3 tree rows have NO such container — their `.flex-1` IS the
            // clickable title (a [data-v3-play] span), so append to the row
            // itself, where the button lands after the favourite button as a
            // sibling flex item.
            const titleContainer = v3 ? null : node.querySelector(':scope > .flex-1');
            (titleContainer || node).appendChild(btn);
        }
    }

    _removeAll() {
        for (const node of document.querySelectorAll(`[data-${FLAG}]`)) {
            node.querySelector('[data-song-preview-play]')?.remove();
            delete node.dataset[FLAG];
        }
        // Hero glyphs are hijacked in place (not injected), so restore them too.
        this._restoreHijacked();
    }

    destroy() {
        document.removeEventListener('pointerup', this._onPointerUp, true);
        document.removeEventListener('click', this._onClick, true);
        document.removeEventListener('scroll', this._onScroll, { capture: true });
        if (this._scrollRaf) { cancelAnimationFrame(this._scrollRaf); this._scrollRaf = 0; }
        if (this._mql.removeEventListener) this._mql.removeEventListener('change', this._onMqlChange);
        else if (this._mql.removeListener) this._mql.removeListener(this._onMqlChange);
        this._removeAll();
        document.getElementById(STYLE_ID)?.remove();
    }
}
