// Regression tests for the "library stutters until you can't scroll" report.
//
// The host's v3 Songs grid is VIRTUALIZED with in-place node recycling, and it
// has one hard invariant: every card is the same height. measureGeom() measures
// ONE card (`grid.querySelector('[data-fn]')`) and derives every row position
// and the sizer height from it (static/v3/songs.js).
//
// This plugin used to append the "Fix Missing Preview" button as an IN-FLOW
// block (`mt-2 w-full`) into ONLY the cards whose song has no preview. That
// makes card heights non-uniform, so the grid's row math oscillates depending
// on which card happens to get measured — scroll position mis-maps and the
// library stutters. It only ever reproduced when SOME songs lacked previews,
// which is exactly what the tester reported.
//
// Two invariants are pinned here:
//   1. The card affordance is an absolutely-positioned OVERLAY in every state
//      (idle / fixing / error) — it can never contribute height.
//   2. decorate() on an already-decorated recycled node is idempotent — no
//      duplicate wraps and no signature busting (a re-render per tick is the
//      other half of the jank, and a <button> rebuilt between mousedown and
//      mouseup never emits a click).
//
// Plus the observer guard end-to-end: the mutation our OWN inject causes must
// not schedule another inject.
//
// jsdom is not available (the repo has no package manifest or node_modules),
// and offsetHeight would be 0 there anyway — so the DOM is stubbed by hand
// (same approach as menu_gate.test.mjs) and the assertions are STRUCTURAL:
// position/class rather than measured pixels.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── minimal DOM stub ────────────────────────────────────────────────────────
//
// Supports only what the decorate path actually uses: a tiny selector matcher
// (comma lists, `#id`, `.class`, `[attr]`, tag, and a single descendant
// combinator), attributes/dataset, appendChild/remove, and closest().

const CAMEL = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const KEBAB = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

class El {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.nodeType = 1;
        this.children = [];
        this.parent = null;
        this.attrs = {};
        this._html = '';
        this._listeners = {};
        this.style = {};
        const self = this;
        // dataset ↔ attribute mirror, exactly like the real thing: writing
        // `node.dataset.fooBar` sets `data-foo-bar`. The plugin relies on this
        // correspondence (it reads the dataset but SELECTS on the attribute).
        this.dataset = new Proxy({}, {
            get: (_, k) => self.attrs['data-' + KEBAB(String(k))],
            set: (_, k, v) => { self.attrs['data-' + KEBAB(String(k))] = String(v); return true; },
            has: (_, k) => ('data-' + KEBAB(String(k))) in self.attrs,
            deleteProperty: (_, k) => { delete self.attrs['data-' + KEBAB(String(k))]; return true; },
            ownKeys: () => Object.keys(self.attrs)
                .filter((a) => a.startsWith('data-')).map((a) => CAMEL(a.slice(5))),
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        });
    }

    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = v; }

    get className() { return this.attrs.class || ''; }
    set className(v) { this.attrs.class = v; }

    get classList() {
        const self = this;
        return {
            contains: (c) => (self.attrs.class || '').split(/\s+/).includes(c),
            add: (...cs) => {
                const cur = (self.attrs.class || '').split(/\s+/).filter(Boolean);
                for (const c of cs) if (!cur.includes(c)) cur.push(c);
                self.attrs.class = cur.join(' ');
            },
            remove: (...cs) => {
                self.attrs.class = (self.attrs.class || '').split(/\s+/)
                    .filter((c) => c && !cs.includes(c)).join(' ');
            },
        };
    }

    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }

    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
    removeEventListener() {}

    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    remove() {
        if (!this.parent) return;
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
        this.parent = null;
    }

    // innerHTML is write-mostly here. The plugin only ever ASSIGNS it, and the
    // one thing the tests care about is that assigning replaces (rather than
    // stacks) content — so it drops any element children.
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this.children = []; }

    get isConnected() {
        for (let n = this; n; n = n.parent) if (n._isDocRoot) return true;
        return false;
    }

    get descendants() {
        const out = [];
        const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
        walk(this);
        return out;
    }

    matches(sel) { return _matches(this, sel); }

    querySelector(sel) {
        for (const d of this.descendants) if (_matches(d, sel, this)) return d;
        return null;
    }

    querySelectorAll(sel) {
        return this.descendants.filter((d) => _matches(d, sel, this));
    }

    closest(sel) {
        for (let n = this; n; n = n.parent) if (_matches(n, sel)) return n;
        return null;
    }
}

// Selector matcher: comma-separated list; each alternative may be
// "<ancestor> <target>" (one descendant combinator) or ":scope > <target>".
function _matches(el, sel, scope) {
    for (const alt of String(sel).split(',')) {
        const s = alt.trim();
        if (!s) continue;
        if (s.startsWith(':scope >')) {
            const target = s.slice(':scope >'.length).trim();
            if (el.parent === scope && _simple(el, target)) return true;
            continue;
        }
        const parts = s.split(/\s+/);
        if (parts.length === 1) {
            if (_simple(el, parts[0])) return true;
            continue;
        }
        // "<ancestor> <target>"
        const [anc, target] = parts;
        if (!_simple(el, target)) continue;
        for (let n = el.parent; n; n = n.parent) if (_simple(n, anc)) return true;
    }
    return false;
}

// One compound selector: tag / #id / .class / [attr] / [attr="v"], stackable.
function _simple(el, comp) {
    const tokens = comp.match(/(^[a-zA-Z][\w-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])/g) || [];
    if (!tokens.length) return false;
    for (const t of tokens) {
        if (t[0] === '#') { if (el.id !== t.slice(1)) return false; }
        else if (t[0] === '.') { if (!el.classList.contains(t.slice(1))) return false; }
        else if (t[0] === '[') {
            const body = t.slice(1, -1);
            const eq = body.indexOf('=');
            if (eq === -1) { if (!el.hasAttribute(body)) return false; }
            else {
                const k = body.slice(0, eq);
                const v = body.slice(eq + 1).replace(/^["']|["']$/g, '');
                if (el.getAttribute(k) !== v) return false;
            }
        } else if (el.tagName !== t.toUpperCase()) return false;
    }
    return true;
}

function installDom() {
    const root = new El('html');
    root._isDocRoot = true;
    const head = root.appendChild(new El('head'));
    const body = root.appendChild(new El('body'));
    globalThis.document = {
        head,
        body,
        _root: root,
        createElement: (t) => new El(t),
        getElementById: (id) => root.descendants.find((d) => d.id === id) || null,
        querySelector: (s) => root.querySelector(s),
        querySelectorAll: (s) => root.querySelectorAll(s),
        addEventListener() {},
        removeEventListener() {},
    };
    // v3 grid cards' art square is already position:relative in the host CSS.
    globalThis.getComputedStyle = () => ({ position: 'relative' });
    globalThis.localStorage = {
        getItem: () => null,
        setItem: () => {},
    };
    globalThis.fetch = () => new Promise(() => {});   // never resolves: no audit in these tests
    return { root, body };
}

// Build the host's v3 Songs screen with `n` grid cards, mirroring the real
// markup from static/v3/songs.js songCard(): an outer `.group.relative[data-fn]`
// whose first child is the `relative aspect-square` play surface, followed by
// the title / artist / chip rows.
function buildV3Grid(filenames) {
    const { body } = installDom();
    const songs = new El('div');
    songs.id = 'v3-songs';
    body.appendChild(songs);
    const grid = new El('div');
    grid.id = 'v3-songs-grid';
    songs.appendChild(grid);
    const cards = filenames.map((fn) => {
        const card = new El('div');
        card.className = 'group relative';
        card.setAttribute('data-fn', fn);
        const art = new El('div');
        art.className = 'relative aspect-square rounded-lg overflow-hidden bg-fb-card cursor-pointer';
        art.setAttribute('data-v3-play', '');
        card.appendChild(art);
        const title = new El('div'); title.className = 'mt-1 text-sm truncate';
        const artist = new El('div'); artist.className = 'text-xs truncate';
        const chips = new El('div'); chips.className = 'v3-card-chips flex gap-1 mt-1';
        card.appendChild(title); card.appendChild(artist); card.appendChild(chips);
        grid.appendChild(card);
        return card;
    });
    return { grid, cards };
}

const { PreviewBackfill } = await (async () => {
    installDom();
    return import('../js/preview-backfill.js');
})();
const { isSelfInflictedMutation } = await import('../js/mutation-guard.js');

function makeBackfill(missing) {
    const bf = new PreviewBackfill({});
    bf._missing = new Set(missing);
    bf._entries = missing.map((f) => ({ filename: f, title: f, artist: 'x' }));
    return bf;
}

const A = 'has-preview.sloppak';
const B = 'no-preview.sloppak';

// ── 1. the height invariant ─────────────────────────────────────────────────

test('the card Fix affordance is an absolute overlay, never in normal flow', () => {
    const { cards } = buildV3Grid([A, B]);
    makeBackfill([B]).decorate();

    const wrap = cards[1].querySelector('[data-fix-missing-preview]');
    assert.ok(wrap, 'the preview-less card must get a Fix affordance');
    assert.ok(wrap.className.includes('sp-fix-overlay'),
        `wrap must use the absolutely-positioned overlay class, got "${wrap.className}"`);
    // The regression, pinned explicitly: these are the in-flow classes the old
    // implementation used, and any of them re-introduces the height delta.
    for (const flowClass of ['mt-2', 'px-4', 'pb-4', '-mt-1', 'w-full']) {
        assert.ok(!wrap.className.split(/\s+/).includes(flowClass),
            `wrap must not carry the in-flow class "${flowClass}" — it adds card height`);
    }
});

test('the overlay is anchored INSIDE the art square, not appended to the card', () => {
    const { cards } = buildV3Grid([B]);
    makeBackfill([B]).decorate();

    const card = cards[0];
    const art = card.querySelector('[data-v3-play]');
    const wrap = card.querySelector('[data-fix-missing-preview]');
    assert.equal(wrap.parent, art,
        'the wrap must live in the aspect-square art surface (overflow-hidden, ' +
        'fixed aspect ratio) — appending to the card itself is what grew it');
    // The card's own child list — art + title + artist + chips — must be
    // byte-identical to an undecorated card's, since measureGeom() sizes rows
    // off the card box.
    assert.equal(card.children.length, 4,
        'the card must gain no new in-flow children');
});

test('every decorated state stays an overlay (idle / fixing / error)', () => {
    for (const state of [null, 'fixing', 'error']) {
        const { cards } = buildV3Grid([B]);
        const bf = makeBackfill([B]);
        if (state) bf._fileState.set(B, state);
        if (state === 'error') bf._fileError.set(B, 'boom');
        bf.decorate();

        const wrap = cards[0].querySelector('[data-fix-missing-preview]');
        assert.ok(wrap.className.includes('sp-fix-overlay'),
            `state "${state || 'idle'}" must still render inside the overlay wrap`);
        assert.equal(wrap.parent.getAttribute('data-v3-play'), '',
            `state "${state || 'idle'}" must stay anchored in the art square`);
        assert.ok(!/\bmt-2 w-full\b/.test(wrap.innerHTML),
            `state "${state || 'idle'}" must not render the old full-width in-flow block`);
    }
});

test('cards WITH a preview are left completely untouched', () => {
    const { cards } = buildV3Grid([A, B]);
    makeBackfill([B]).decorate();

    assert.equal(cards[0].querySelector('[data-fix-missing-preview]'), null);
    assert.equal(cards[0].children.length, 4);
    // Non-uniform height is the bug; the decorated and undecorated cards must
    // have the same in-flow structure.
    assert.equal(cards[0].children.length, cards[1].children.length,
        'decorated and undecorated cards must keep identical in-flow structure');
});

// ── 2. idempotence across recycled nodes ────────────────────────────────────

test('decorate() is idempotent — no duplicate wraps across repeated ticks', () => {
    const { cards } = buildV3Grid([B]);
    const bf = makeBackfill([B]);
    for (let i = 0; i < 30; i++) bf.decorate();   // ~half a second of scroll ticks

    // Counted card-wide, not per-anchor, so this tests DUPLICATION only and
    // stays independent of where the wrap is mounted.
    const wraps = cards[0].querySelectorAll('[data-fix-missing-preview]');
    assert.equal(wraps.length, 1, 'repeated decorates must not stack wraps');
});

test('a steady-state decorate() does not bust the render signature (no rebuild per tick)', () => {
    const { cards } = buildV3Grid([B]);
    const bf = makeBackfill([B]);
    bf.decorate();

    const wrap = cards[0].querySelector('[data-fix-missing-preview]');
    const sig = wrap.dataset.fixSig;
    assert.ok(sig, 'the wrap must carry a render signature');
    let writes = 0;
    const raw = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(wrap), 'innerHTML');
    Object.defineProperty(wrap, 'innerHTML', {
        get: () => raw.get.call(wrap),
        set: (v) => { writes++; raw.set.call(wrap, v); },
    });

    for (let i = 0; i < 30; i++) bf.decorate();
    assert.equal(writes, 0,
        'an unchanged card must not have its button rebuilt on every tick — a ' +
        '<button> destroyed between mousedown and mouseup never emits a click');
    assert.equal(wrap.dataset.fixSig, sig, 'the signature must be stable');
});

test('a recycled node whose filename changed is re-wired, not duplicated', () => {
    const { cards } = buildV3Grid([B]);
    const bf = makeBackfill([B, 'other.sloppak']);
    bf.decorate();

    // The host recycles the node in place for a different song (_syncWindow).
    cards[0].setAttribute('data-fn', 'other.sloppak');
    bf.decorate();

    const wraps = cards[0].querySelectorAll('[data-fix-missing-preview]');
    assert.equal(wraps.length, 1, 'recycling must not leave a stale second wrap');
    assert.equal(wraps[0].getAttribute('data-fix-missing-preview'), 'other.sloppak');
});

test('a card whose song is no longer missing has its overlay removed', () => {
    const { cards } = buildV3Grid([B]);
    const bf = makeBackfill([B]);
    bf.decorate();
    assert.ok(cards[0].querySelector('[data-fix-missing-preview]'));

    bf._missing.delete(B);            // the fix landed
    bf.decorate();
    assert.equal(cards[0].querySelector('[data-fix-missing-preview]'), null,
        'the overlay must be swept once the song has a preview');
});

// ── 3. the observer feedback loop ───────────────────────────────────────────

test('the mutation our own inject causes does not schedule another inject', () => {
    const { cards } = buildV3Grid([B]);
    makeBackfill([B]).decorate();

    const card = cards[0];
    const art = card.querySelector('[data-v3-play]');
    const wrap = art.children.find((c) => c.hasAttribute('data-fix-missing-preview'));

    // The record the browser would hand the bootstrap observer for that append.
    const ourRecord = { type: 'childList', target: art, addedNodes: [wrap], removedNodes: [] };
    assert.equal(isSelfInflictedMutation(ourRecord), true,
        'the plugin injecting its own overlay must not re-trigger injectAll — ' +
        'that is the per-frame observer→inject→observer loop');

    // ...while the host recycling a card still does.
    const hostRecord = {
        type: 'childList', target: card.parent, addedNodes: [cards[0]], removedNodes: [],
    };
    assert.equal(isSelfInflictedMutation(hostRecord), false,
        'host re-renders must still schedule an inject');
});

test('every injected root carries the plugin-owned marker', () => {
    const { cards } = buildV3Grid([B]);
    makeBackfill([B]).decorate();
    const wrap = cards[0].querySelector('[data-fix-missing-preview]');
    assert.ok(wrap.hasAttribute('data-song-preview-owned'),
        'without the marker the guard cannot recognise our own mutation');
});

// ── 4. the idle fast path ───────────────────────────────────────────────────

test('decorate() with nothing missing does not sweep the document every tick', () => {
    buildV3Grid([A]);
    const bf = makeBackfill([]);
    let sweeps = 0;
    const real = document.querySelectorAll;
    document.querySelectorAll = (s) => { sweeps++; return real.call(document, s); };

    for (let i = 0; i < 30; i++) bf.decorate();
    document.querySelectorAll = real;

    assert.equal(sweeps, 0,
        'a fully-previewed library must not run a whole-document attribute ' +
        'query on every MutationObserver tick');
});
