// Tests for the observer self-mutation guard (js/mutation-guard.js).
//
// The bootstrap MutationObserver watches the library card containers with
// subtree:true, and the plugin's own decorators (Fix badge, touch button,
// progress ring) append/remove nodes inside that subtree. Unfiltered, each
// injection re-triggers the observer → schedules another inject → decorators
// run again — a per-frame feedback loop while the windowed grid recycles card
// nodes during scroll (the "library stutters until you can't scroll" report).
// The guard drops MutationRecords that only touch plugin-owned nodes, while
// letting every host mutation through.
//
// No test framework in this repo — the DOM is stubbed by hand (same pattern
// as menu_gate.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { OWNED_ATTR, markPluginOwned, isSelfInflictedMutation } from '../js/mutation-guard.js';

const OWNED_SELECTOR = `[${OWNED_ATTR}]`;

// ── minimal DOM stub ────────────────────────────────────────────────────────
function makeEl() {
    return {
        nodeType: 1,
        parent: null,
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        hasAttribute(k) { return k in this.attrs; },
        // closest() works on detached subtrees too — mirrored here by walking
        // the stub parent chain (null parent = detached root).
        closest(sel) {
            assert.equal(sel, OWNED_SELECTOR, 'guard must only query its own marker');
            for (let n = this; n; n = n.parent) {
                if (OWNED_ATTR in n.attrs) return n;
            }
            return null;
        },
    };
}

function textNode() { return { nodeType: 3 }; }

function record({ target, added = [], removed = [] }) {
    return { type: 'childList', target, addedNodes: added, removedNodes: removed };
}

// ── tests ───────────────────────────────────────────────────────────────────

test('markPluginOwned stamps the marker attribute and returns the element', () => {
    const el = makeEl();
    assert.equal(markPluginOwned(el), el);
    assert.ok(el.hasAttribute(OWNED_ATTR));
});

test('injecting a plugin-owned root into a host card is self-inflicted', () => {
    const card = makeEl();                     // host card (unmarked)
    const wrap = markPluginOwned(makeEl());    // our Fix-badge wrap
    assert.equal(
        isSelfInflictedMutation(record({ target: card, added: [wrap] })), true,
        'the append that decorate() itself performs must not re-trigger inject');
});

test('removing a plugin-owned root (detached at callback time) is self-inflicted', () => {
    const card = makeEl();
    const wrap = markPluginOwned(makeEl());    // parent already null = detached
    assert.equal(
        isSelfInflictedMutation(record({ target: card, removed: [wrap] })), true,
        'our own badge removal must not re-trigger inject');
});

test('a state re-render INSIDE an owned wrap is self-inflicted', () => {
    const wrap = markPluginOwned(makeEl());
    const inner = makeEl();                    // e.g. the button innerHTML swapped
    inner.parent = wrap;
    assert.equal(
        isSelfInflictedMutation(record({ target: inner, added: [makeEl()], removed: [makeEl()] })),
        true,
        'innerHTML writes inside our wrap must not re-trigger inject');
});

test('a host re-render (unmarked nodes) always gets through', () => {
    const grid = makeEl();
    const hostCard = makeEl();
    assert.equal(
        isSelfInflictedMutation(record({ target: grid, added: [hostCard] })), false,
        'library re-renders are exactly what the observer exists for');
});

test('a mixed record (host node + owned node) gets through', () => {
    const grid = makeEl();
    assert.equal(
        isSelfInflictedMutation(record({
            target: grid,
            added: [makeEl(), markPluginOwned(makeEl())],
        })),
        false,
        'any host-node involvement disqualifies the skip');
});

test('a text node added under a host target gets through', () => {
    const grid = makeEl();
    assert.equal(
        isSelfInflictedMutation(record({ target: grid, added: [textNode()] })), false);
});

test('an empty childList record on a host target is not claimed as ours', () => {
    const grid = makeEl();
    assert.equal(
        isSelfInflictedMutation(record({ target: grid })), false,
        'no nodes touched → nothing to attribute to the plugin');
});
