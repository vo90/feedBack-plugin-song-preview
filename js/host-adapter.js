// Single source of truth for the library DOM contract, which differs between
// the two host UIs this plugin has to run on:
//
//   - v2 ("classic"):  the library renders `.song-card[data-play]` grid cards
//     and `.song-row[data-play]` list rows; the album-art square is `.card-art`;
//     the filename lives in `data-play`, URI-ENCODED.
//   - v3 ("fee[dB]ack", v0.3.0): the new Songs screen (`#v3-songs`) renders
//     `[data-fn]` cards whose playable surface is a `[data-v3-play]` element
//     (a sizeable DIV in grid view, a small IMG in tree view); the filename
//     lives in `data-fn`, RAW (not encoded).
//
// Everything DOM-coupled in the plugin (the hover loop, progress ring, touch
// buttons, and the "Fix missing preview" badge) routes its card/row/art/filename
// lookups through here so the rest of the code stays markup-agnostic.
//
// Deliberately MARKUP-driven, not flag-driven: we don't read the host's
// late-set UI-version flag (its v3 chrome sets that after this plugin
// boots). Instead we try the legacy selectors first, then the
// v3 ones. On a v2 host the `#v3-songs` selectors simply never match, so v2
// behaviour is unchanged; on v3 both the kept-verbatim legacy screens
// (Favorites reuses `#favorites`/`fav-grid`) AND the new `#v3-songs` browser are
// handled by the same code path.

const LEGACY_PREVIEWABLE = '.song-card[data-play], .song-row[data-play]';
// Scoped to #v3-songs so [data-fn] nodes elsewhere in v3 (playlist/saved cards)
// don't trigger previews. `closest()` accepts this descendant-combinator
// selector.
const V3_PREVIEWABLE = '#v3-songs [data-fn]';
// v3 dashboard (#v3-home) song tiles also get hover previews: the "Jump back
// in!" recently-played grid (`[data-recent]`), the Pick-a-song hero
// (`#v3-pick`, which carries `data-fn`), and the Continue-Playing card
// (`#v3-continue`, which has no filename attribute — its filename is recovered
// from the art img src, see readFilename). These feed previewableFrom only, NOT
// allPreviewableNodes(), so the dashboard gets hover-to-listen without the Fix
// badge / touch-button decorations (those stay on the library surfaces).
const V3_DASHBOARD = '#v3-home [data-recent], #v3-home [data-fn], #v3-home #v3-continue';

// A v3 card only counts as previewable once it actually carries a play surface
// (`[data-v3-play]`); a bare [data-fn] wrapper mid-render isn't playable yet.
function _isV3PreviewableCard(card) {
    return !!(card && card.matches && card.matches(V3_PREVIEWABLE)
        && card.querySelector && card.querySelector('[data-v3-play]'));
}

function _isLegacyCard(card) {
    return !!(card && card.matches && card.matches(LEGACY_PREVIEWABLE));
}

// The Continue-Playing dashboard card exposes no filename attribute, but its art
// img src is `/api/song/<encoded-filename>/art` — recover the filename there.
// Also a general fallback for any card whose only handle is its art thumbnail.
function _filenameFromArtSrc(card) {
    const img = card.querySelector ? card.querySelector('img[src*="/api/song/"]') : null;
    if (!img) return null;
    const m = (img.getAttribute('src') || '').match(/\/api\/song\/(.+?)\/art(?:[?#]|$)/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); }
    catch (_) { return m[1]; }
}

// Nearest previewable card/row that contains `el` (a hit-test result, focused
// element, or button), or null. Tries legacy markup, then the v3 Songs grid,
// then the v3 dashboard tiles.
export function previewableFrom(el) {
    if (!el || typeof el.closest !== 'function') return null;
    const legacy = el.closest(LEGACY_PREVIEWABLE);
    if (legacy) return legacy;
    const v3 = el.closest(V3_PREVIEWABLE);
    if (_isV3PreviewableCard(v3)) return v3;
    const dash = el.closest(V3_DASHBOARD);
    if (dash && readFilename(dash)) return dash;
    return null;
}

// The decoded local filename a card represents, or null. v2 stores it
// URI-encoded in `data-play`; v3 stores the raw filename in `data-fn`. Callers
// always receive the decoded name (the audio backend URL re-encodes it).
export function readFilename(card) {
    if (!card) return null;
    if (_isLegacyCard(card)) {
        const raw = card.getAttribute('data-play') || '';
        if (!raw) return null;
        try { return decodeURIComponent(raw); }
        catch (_) { return raw; }
    }
    if (card.hasAttribute && card.hasAttribute('data-fn')) {
        return card.getAttribute('data-fn') || null;
    }
    // v3 "Jump back in!" recently-played tile.
    if (card.hasAttribute && card.hasAttribute('data-recent')) {
        return card.getAttribute('data-recent') || null;
    }
    // v3 Continue-Playing card: filename only in the art img src.
    return _filenameFromArtSrc(card);
}

// The surface the progress ring is drawn on / the touch button is overlaid
// into: the v2 album-art square (`.card-art`), else the v3 grid card's
// `[data-v3-play]` DIV. Returns null for rows (v2 `.song-row`, v3 tree rows) —
// they have no art square, so callers trace/anchor the row itself.
export function artElement(card) {
    if (!card || !card.querySelector) return null;
    const legacyArt = card.querySelector('.card-art');
    if (legacyArt) return legacyArt;
    // v3 list/tree rows (#v3-songs-tree) have no art square — trace the row
    // itself. Decide by CONTAINER, not by the inner [data-v3-play] tag shape,
    // which isn't reliable across host builds.
    if (card.closest && card.closest('#v3-songs-tree')) return null;
    const v3play = card.querySelector('[data-v3-play]');
    if (v3play && v3play.tagName === 'DIV') return v3play;
    // v3 dashboard tiles: the recently-played card wraps its art in an inner
    // `.aspect-square` block; the Continue/Pick hero cards are themselves the
    // aspect-square button (art is absolute-inset), so trace the card itself.
    const id = card.id || '';
    if ((card.hasAttribute && card.hasAttribute('data-recent')) || id === 'v3-continue' || id === 'v3-pick') {
        return card.querySelector('.aspect-square') || card;
    }
    return null;
}

// True for a v3 ("fee[dB]ack") card/row, false for a v2 one (or null). v3 cards
// carry `data-fn`; v2 cards carry `data-play`. Lets callers that mount markup
// into the card BODY (the Fix badge) pick padding that matches the host card:
// v2 bodies live inside a `.p-4` block, v3 bodies are flush to the card edge.
export function isV3Card(card) {
    return !!(card && card.hasAttribute && card.hasAttribute('data-fn'));
}

// True for grid cards (album-art square), false for list rows. Drives touch
// button placement (overlay on art vs inline beside the title) and the progress
// ring anchor. Dashboard tiles are art-square cards too.
export function isGridCard(card) {
    if (!card) return false;
    if (card.classList && card.classList.contains('song-card')) return true; // v2 grid
    const id = card.id || '';
    if ((card.hasAttribute && card.hasAttribute('data-recent')) || id === 'v3-continue' || id === 'v3-pick') return true; // dashboard tiles
    // Decide by CONTAINER — grid cards in #v3-songs-grid, list rows in
    // #v3-songs-tree. This is called per-node in the touch/backfill decorate
    // loops, which run over the WHOLE library at once in tree view (~thousands
    // of rows). It must NOT read layout (clientWidth/getComputedStyle): a layout
    // read after each button injection forces a synchronous reflow, and thousands
    // of them froze the first list-view preview for ~15s. `closest()` is pure DOM
    // traversal — no reflow.
    if (card.closest) {
        if (card.closest('#v3-songs-grid')) return true;
        if (card.closest('#v3-songs-tree')) return false;
    }
    const v3play = card.querySelector ? card.querySelector('[data-v3-play]') : null;
    return !!(v3play && v3play.tagName === 'DIV');
}

// True for the v3 dashboard hero card (Continue-Playing / Pick-a-song). Its art
// fills the whole card with text overlaid at the bottom, so a touch button
// belongs mid-edge rather than the usual bottom corner.
export function isDashboardHero(card) {
    const id = card && card.id ? card.id : '';
    return id === 'v3-continue' || id === 'v3-pick';
}

// The card-bearing library containers, by host version. Mirrors the list the
// bootstrap observer (screen.js) narrows itself to — cards outside these never
// get observed ticks, so scanning wider would be wasted work anyway.
const LEGACY_CONTAINER_IDS = ['lib-grid', 'lib-tree', 'fav-grid', 'fav-tree'];

// Every previewable LIBRARY card/row currently in the DOM, across both markups.
// Used by the per-tick decorators for the Fix badge (library only) and the touch
// buttons (which ALSO cover the dashboard via dashboardPreviewableNodes).
//
// Scoped to the known containers rather than document-wide: this runs on every
// MutationObserver tick (i.e. every scroll frame while the windowed grid
// recycles nodes), and a document-level selector that MISSES — e.g. the legacy
// one on a v3 host — can't short-circuit; it walks the entire document before
// returning empty. getElementById + container-scoped querySelectorAll keeps the
// walk bounded to the cards that can actually match. The document-wide sweep
// survives only as a fallback for a host with none of the known containers.
export function allPreviewableNodes() {
    const out = [];
    const legacyRoots = [];
    for (const id of LEGACY_CONTAINER_IDS) {
        const el = document.getElementById(id);
        if (el) legacyRoots.push(el);
    }
    const v3Root = document.getElementById('v3-songs');
    if (legacyRoots.length || v3Root) {
        for (const root of legacyRoots) {
            for (const n of root.querySelectorAll(LEGACY_PREVIEWABLE)) out.push(n);
        }
    } else {
        for (const n of document.querySelectorAll(LEGACY_PREVIEWABLE)) out.push(n);
    }
    if (v3Root) {
        for (const n of v3Root.querySelectorAll('[data-fn]')) {
            if (_isV3PreviewableCard(n)) out.push(n);
        }
    }
    return out;
}

// v3 dashboard (#v3-home) song tiles with a resolvable filename. Separate from
// allPreviewableNodes() so touch play buttons can land here WITHOUT the Fix
// badge / management affordances (the dashboard isn't a library-management
// surface, and the hero card has no room for them).
export function dashboardPreviewableNodes() {
    const out = [];
    for (const n of document.querySelectorAll(V3_DASHBOARD)) {
        if (readFilename(n)) out.push(n);
    }
    return out;
}
