// Self-mutation guard for the bootstrap MutationObserver (screen.js).
//
// The plugin's decorators (the Fix badge, the touch play button, the progress
// ring) appendChild/remove nodes INSIDE the very card containers the bootstrap
// observer watches with subtree:true. Left unguarded, every one of those
// injections is a childList mutation that re-triggers the observer, which
// schedules another injectAll, which decorates again — and while the host's
// windowed grid is recycling card nodes on every scroll frame, that feedback
// loop runs per frame and amplifies scroll jank into "can't actually scroll".
//
// The guard is record-based, not flag-based: every root the plugin injects is
// stamped with a marker attribute (markPluginOwned), and the observer callback
// drops any MutationRecord that only touches marked nodes (or happened inside
// one). A reentrancy flag can't do this job — the observer callback runs as a
// microtask AFTER the injecting call returned, so there is no "while injecting"
// window to flag.

export const OWNED_ATTR = 'data-song-preview-owned';
const OWNED_SELECTOR = `[${OWNED_ATTR}]`;

// Stamp an element (an injected root) as plugin-owned. Returns the element so
// call sites can stay single-expression.
export function markPluginOwned(el) {
    el.setAttribute(OWNED_ATTR, '');
    return el;
}

// True when `n` is an element inside (or itself) a plugin-owned root. Works on
// detached nodes too — closest() on a just-removed subtree still sees the
// removed root's own attributes, which is exactly what the removedNodes check
// needs.
function _inOwnedSubtree(n) {
    return !!(n && n.nodeType === 1 && typeof n.closest === 'function'
        && n.closest(OWNED_SELECTOR));
}

// True when a childList MutationRecord was caused by the plugin's own DOM
// work: either the mutation happened inside a plugin-owned root (state
// re-renders via innerHTML), or every node it added/removed is a plugin-owned
// root (the inject/remove itself). Any host-node involvement → false, so real
// library re-renders always get through.
export function isSelfInflictedMutation(m) {
    if (_inOwnedSubtree(m.target)) return true;
    let sawNode = false;
    for (const list of [m.addedNodes, m.removedNodes]) {
        if (!list) continue;
        for (const n of list) {
            sawNode = true;
            if (!_inOwnedSubtree(n)) return false;
        }
    }
    return sawNode;
}
