// Regression test for the per-frame full-document query in MenuGate.
//
// isAnyMenuOpen() runs on EVERY rAF tick (~60/sec). It used to end with a bare
// `document.querySelector('.v3-card-menu')`. A class selector that MISSES — the
// normal case, no menu open — cannot short-circuit: it walks the entire
// document before returning null. The Songs screen renders one card per song,
// so on a large library that one line walked a huge tree 60x/sec. Measured on a
// 50,944-song library: ~50% of the whole renderer CPU, 2 fps.
//
// The gate must therefore never touch document.querySelector on the hot path,
// while still reporting an open card menu. No test framework in this repo, so
// the DOM is stubbed by hand.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── minimal DOM stub ────────────────────────────────────────────────────────
function makeEl(cls = []) {
    return {
        nodeType: 1,
        isConnected: true,
        classList: { contains: (c) => cls.includes(c) },
        querySelector: () => null,
        dataset: {},
        addEventListener() {},
        removeEventListener() {},
    };
}

let queryCount = 0;
let observers = [];

function installDom() {
    queryCount = 0;
    observers = [];
    globalThis.document = {
        body: makeEl(),
        getElementById: () => null,
        querySelector: () => { queryCount++; return null; },
    };
    globalThis.MutationObserver = class {
        constructor(cb) { this.cb = cb; observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
        // test helper: simulate the DOM adding nodes
        emitAdded(nodes) { this.cb([{ addedNodes: nodes }]); }
    };
}

const { MenuGate } = await (async () => {
    installDom();
    return import('../js/menu-gate.js');
})();

test('hot path never walks the document (the 2-fps regression)', () => {
    installDom();
    const gate = new MenuGate();

    gate.isAnyMenuOpen();                 // first call installs the observer
    const afterWarmup = queryCount;       // one allowed: catches an already-open menu

    for (let i = 0; i < 600; i++) gate.isAnyMenuOpen();   // ~10 seconds of ticks

    assert.equal(queryCount, afterWarmup,
        'isAnyMenuOpen must not call document.querySelector on the hot path — ' +
        'that is the full-document walk that cost ~50% of the renderer');
    assert.ok(afterWarmup <= 1, 'at most one warmup query');
});

test('an opened card menu still opens the gate', () => {
    installDom();
    const gate = new MenuGate();
    assert.equal(gate.isAnyMenuOpen(), false, 'nothing open to begin with');
    // (that first call also installs the observer — it is lazy)

    const menu = makeEl(['v3-card-menu']);
    observers[0].emitAdded([menu]);       // songs.js appends the menu

    assert.equal(gate.isAnyMenuOpen(), true, 'gate must see the open card menu');
});

test('a detached menu releases the gate (no latch)', () => {
    installDom();
    const gate = new MenuGate();
    gate.isAnyMenuOpen();                 // installs the observer (lazy)
    const menu = makeEl(['v3-card-menu']);
    observers[0].emitAdded([menu]);
    assert.equal(gate.isAnyMenuOpen(), true);

    // Closed directly, OR the card containing it was replaced by a re-render —
    // isConnected covers both, which is why we validate rather than trust the ref.
    menu.isConnected = false;

    assert.equal(gate.isAnyMenuOpen(), false, 'a detached menu must not latch the gate open');
});

test('a menu nested inside an added subtree is still found', () => {
    installDom();
    const gate = new MenuGate();
    gate.isAnyMenuOpen();                 // installs the observer (lazy)
    const menu = makeEl(['v3-card-menu']);
    const wrapper = makeEl();
    wrapper.querySelector = (sel) => (sel === '.v3-card-menu' ? menu : null);

    observers[0].emitAdded([wrapper]);

    assert.equal(gate.isAnyMenuOpen(), true, 'a wrapped menu must not silently disable the gate');
});

test('destroy() disconnects the observer', () => {
    installDom();
    const gate = new MenuGate();
    gate.isAnyMenuOpen();
    gate.destroy();
    assert.ok(observers[0].disconnected, 'observer must be disconnected on destroy');
    assert.equal(gate._cardMenu, null);
});
