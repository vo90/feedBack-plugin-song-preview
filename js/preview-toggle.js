// Binds the Settings page toggle and the dedicated screen toggle to a
// single localStorage flag. Mirrors changes between both DOM toggles
// when either is flipped, so they stay in sync.
export class PreviewToggle {
    constructor() {
        this.STORAGE_KEY = 'slopsmith_song_preview_enabled';
        this.TOGGLE_IDS = ['song-preview-enabled', 'song-preview-enabled-screen'];
        this._handlers = new WeakMap();
    }

    isEnabled() {
        return localStorage.getItem(this.STORAGE_KEY) !== 'false';
    }

    setEnabled(on) {
        localStorage.setItem(this.STORAGE_KEY, on ? 'true' : 'false');
        for (const id of this.TOGGLE_IDS) {
            const el = document.getElementById(id);
            if (el && el.checked !== on) el.checked = on;
        }
    }

    // Idempotent — safe to call repeatedly as views render in. dataset
    // flag prevents double-binding.
    bindDom() {
        for (const id of this.TOGGLE_IDS) {
            const el = document.getElementById(id);
            if (!el || el.dataset.songPreviewBound) continue;
            el.dataset.songPreviewBound = '1';
            el.checked = this.isEnabled();
            const handler = () => this.setEnabled(el.checked);
            this._handlers.set(el, handler);
            el.addEventListener('change', handler);
        }
    }

    destroy() {
        for (const id of this.TOGGLE_IDS) {
            const el = document.getElementById(id);
            if (!el) continue;
            const handler = this._handlers.get(el);
            if (handler) el.removeEventListener('change', handler);
            delete el.dataset.songPreviewBound;
        }
    }
}