// Owns preview playback: a dedicated native player on capable Desktop hosts,
// otherwise the shared <audio> element used by browser/touch installations.
// Centralises start/stop, the inter-song handoff, and detection of "some other audio
// just started — get out of its way". Pub/sub keeps ProgressScope and
// PreviewLoop loosely coupled to playback state:
//   'play'      (file, host)   — audio is actually flowing (not just loading).
//   'stop'      (reason)       — any state-clear: manual stop, end, error,
//                                song switch, play() rejected, external audio
//                                override. Listeners use this for cleanup.
//   'completed' (file)         — natural 'ended' only. Drives the single-play
//                                gate so a clip won't immediately replay.
//   'failed'    (file)         — native failure/interruption; suppress automatic
//                                retries until the user leaves this song.
// Preview volume is persisted as 0..100 (matching fee[dB]ack's mixer
// convention) and applied to the preview <audio> as 0..1. It is the plugin's
// OWN level — deliberately independent of the host Song channel.
const VOLUME_KEY = 'slopsmith_song_preview_volume';
const DEFAULT_VOLUME = 0.2;
// The slider controls loudness only — turning previews OFF is the toggle's job.
// So volume never reaches 0: it floors at a quiet-but-audible minimum. (Also
// migrates any stale 0 saved by an earlier build up to the floor.)
const MIN_VOLUME = 0.05;

export class AudioController {
    constructor({ apiBase, pluginName }) {
        this._apiBase = apiBase;
        this._pluginName = pluginName;
        this._audio = null;
        this._loadingFile = null;
        this._playingFile = null;
        this._activeHost = null;
        this._externalAudioActive = false;
        this._playListenerInstalled = false;
        this._listeners = { play: [], stop: [], completed: [], failed: [] };
        this._serial = 0;
        this._destroyed = false;
        this._route = null;
        this._nativeRequestId = null;
        this._nativeGeneration = null;
        this._nativeTimer = null;
        this._nativeClock = { currentTime: 0, duration: 0 };
        this._nativeCapabilities = null;
        this._errorNotice = null;
        const api = window.feedBackDesktop?.audio;
        this._nativeApi = api && ['previewCapabilities', 'startPreview', 'stopPreview',
            'setPreviewVolume', 'getPreviewSnapshot'].every(name => typeof api[name] === 'function') ? api : null;

        // Sticky memo of filenames the server has 404'd for. The hover
        // loop polls a candidate target every debounce tick — without
        // this, sitting on a card whose sloppak has no embedded preview
        // would fire one network request + one HTMLMediaElement load
        // cycle per tick (we saw ~38 redundant 404s in a single hover
        // dwell). PreviewBackfill clears entries via clearNoPreviewMemo()
        // once a backfill succeeds, so a freshly-injected preview gets
        // picked up without a page reload.
        this._noPreviewFiles = new Set();

        // iOS ignores HTMLMediaElement.volume entirely (loudness is hardware-only
        // there), so the preview-volume slider was a no-op on iPhone/iPad. On
        // touch devices we therefore route playback through a Web Audio
        // GainNode, whose gain IS respected on iOS and Android. Desktop keeps the
        // simpler element-volume path: hover-triggered playback isn't a user
        // gesture, so it can't reliably resume a (possibly suspended) AudioContext.
        this._useWebAudio = (() => {
            try { return window.matchMedia('(hover: none) and (pointer: coarse)').matches; }
            catch (_) { return false; }
        })();
        this._audioCtx = null;
        this._sourceNode = null;
        this._gainNode = null;

        // Preview volume is the plugin's own level (see VOLUME_KEY), decoupled
        // from the host Song channel. Cross-tab drags fire 'storage'; same-tab
        // changes call setVolume() directly, and start() re-applies it so the
        // next hover always uses the current level.
        this._volume = this._loadVolume();
        this._onStorage = (e) => {
            if (e.key === VOLUME_KEY) {
                this._volume = this._loadVolume();
                this._applyVolume();
            }
        };
        window.addEventListener('storage', this._onStorage);

        // 'play' doesn't bubble — capture-phase document listener catches
        // anything else (host, another plugin) starting audio. Installed
        // lazily on the first preview so destroy() can pair them.
        this._onDocumentPlay = (e) => {
            if (e.target !== this._audio) this.externalAudioStarted();
        };
    }

    on(event, cb) {
        if (!this._listeners[event]) throw new Error(`unknown event: ${event}`);
        this._listeners[event].push(cb);
    }

    _emit(event, ...args) {
        for (const cb of this._listeners[event]) cb(...args);
    }

    isActive() { return !!(this._loadingFile || this._playingFile); }
    currentFile() { return this._playingFile || this._loadingFile; }
    activeHost() { return this._activeHost; }
    // ProgressScope only reads currentTime/duration. Native playback never
    // creates or starts a browser audio element just to supply this clock.
    audioElement() { return this._route === 'native' ? this._nativeClock : this._audio; }
    isExternalAudioActive() { return this._externalAudioActive; }
    clearExternalAudio() { this._externalAudioActive = false; }
    externalAudioStarted() {
        this.stop('external-audio');
        this._externalAudioActive = true;
    }
    // Called by PreviewBackfill after a successful inject so the next
    // hover doesn't bounce off the stale memo.
    clearNoPreviewMemo(filename) { this._noPreviewFiles.delete(filename); }

    _loadVolume() {
        try {
            const raw = parseFloat(localStorage.getItem(VOLUME_KEY));
            if (Number.isFinite(raw)) return Math.min(1, Math.max(MIN_VOLUME, raw / 100));
        } catch (_) { /* sandboxed storage — fall back to default */ }
        return DEFAULT_VOLUME;
    }

    // 0..1. Read by PreviewLoop's volume gate and the volume slider UI.
    getVolume() { return this._volume; }

    // Called by the volume slider. Persists (as 0..100) and applies live so a
    // drag updates an in-flight preview in real time.
    setVolume(v) {
        this._volume = Math.min(1, Math.max(MIN_VOLUME, Number(v) || 0));
        try { localStorage.setItem(VOLUME_KEY, String(Math.round(this._volume * 100))); }
        catch (_) { /* sandboxed storage — in-memory only this session */ }
        this._applyVolume();
    }

    _applyVolume() {
        if (this._route === 'native' && this._nativeRequestId) {
            const serial = this._serial;
            const requestId = this._nativeRequestId, volume = this._volume;
            Promise.resolve().then(() => this._nativeApi.setPreviewVolume({
                requestId, volume,
            })).catch(error => this._failNative(serial, error));
            return;
        }
        // Touch: control loudness via the Web Audio gain (element volume is a
        // no-op on iOS). Pin the element to unity so it's the gain alone — on
        // Android, where element volume also works, the two would multiply.
        if (this._gainNode) {
            try { this._gainNode.gain.value = this._volume; } catch (_) {}
            if (this._audio) { try { this._audio.volume = 1; } catch (_) {} }
            return;
        }
        if (this._audio) { try { this._audio.volume = this._volume; } catch (_) {} }
    }

    // Route the preview <audio> through a GainNode so the volume slider works on
    // iOS (where <audio>.volume is ignored). Best-effort: on any failure we fall
    // back to element volume. Touch devices only — see the constructor note.
    _setupWebAudio(audio) {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            // createMediaElementSource may be called only ONCE per element, and
            // afterwards the element's audio flows ONLY through this graph — so we
            // must connect to the destination or playback goes silent.
            const source = ctx.createMediaElementSource(audio);
            const gain = ctx.createGain();
            gain.gain.value = this._volume;
            source.connect(gain);
            gain.connect(ctx.destination);
            this._audioCtx = ctx;
            this._sourceNode = source;
            this._gainNode = gain;
        } catch (_) {
            this._audioCtx = null;
            this._sourceNode = null;
            this._gainNode = null;
        }
    }

    _ensureAudio() {
        if (this._audio) return this._audio;
        const audio = document.createElement('audio');
        audio.preload = 'none';
        document.body.appendChild(audio);

        audio.addEventListener('playing', () => {
            if (this._route !== 'browser') return;
            if (this._loadingFile) {
                this._playingFile = this._loadingFile;
                this._loadingFile = null;
            }
            // Listeners (ProgressScope) attach only once audio is flowing,
            // so the perimeter ring doesn't paint a flat line during the
            // initial fetch/transcode.
            this._emit('play', this._playingFile, this._activeHost);
        });
        audio.addEventListener('ended', () => {
            if (this._route !== 'browser') return;
            const finished = this._playingFile || this._loadingFile;
            this._clear();
            this._emit('stop', 'ended');
            this._emit('completed', finished);
        });
        audio.addEventListener('error', () => {
            if (this._route !== 'browser') return;
            // Cancelling via audio.src = '' resolves the empty string to
            // the page URL, which the decoder rejects and surfaces as a
            // spurious 'error' with no active file. Ignore that.
            const active = this._loadingFile || this._playingFile;
            if (!active) return;
            console.warn(`[${this._pluginName}] audio error for`, active);
            // HTMLMediaElement.error doesn't expose the HTTP status, so
            // do a one-shot HEAD probe to see if the preview is missing
            // (404) vs a real codec/network error. We memoize on 404 OR
            // 405 — 405 means the server doesn't speak HEAD (older
            // backend), and in that case the only reason we'd be here
            // is that the original GET also failed; assume preview-
            // missing so the hover loop stops retrying. Transient 5xx
            // stay unmemoized so they'll be retried on next hover.
            const url = `${this._apiBase}/audio?file=${encodeURIComponent(active)}`;
            fetch(url, { method: 'HEAD' }).then(r => {
                if (r.status === 404 || r.status === 405) {
                    this._noPreviewFiles.add(active);
                }
            }).catch(() => { /* network gone, treat as transient */ });
            this._clear();
            this._emit('stop', 'error');
        });

        this._ensurePlayListener();

        this._audio = audio;
        if (this._useWebAudio) this._setupWebAudio(audio);
        return audio;
    }

    _clear() {
        this._loadingFile = null;
        this._playingFile = null;
        this._activeHost = null;
        this._route = null;
    }

    start(filename, host) {
        if (this._destroyed) return;
        if (this._loadingFile === filename || this._playingFile === filename) return;
        // Short-circuit hover spam on files we already know have no
        // preview. Cleared per-file by PreviewBackfill on successful
        // injection so the new clip plays immediately after Fix.
        if (this._noPreviewFiles.has(filename)) return;
        if (this.isActive()) this.stop('switch');
        const serial = ++this._serial;
        this._loadingFile = filename;
        this._activeHost = host || null;
        this._route = 'pending';
        this._ensurePlayListener();
        this._clearError();
        // Keep browser/touch play() inside the original user gesture. Only
        // desktops advertising the complete native API need async discovery.
        if (!this._nativeApi) return this._startBrowser(filename, serial);
        if (!this._nativeCapabilities) {
            this._nativeCapabilities = Promise.resolve().then(() => this._nativeApi.previewCapabilities());
        }
        this._nativeCapabilities.then(capabilities => {
            if (!this._isCurrent(serial)) return;
            if (capabilities?.native === true && capabilities.version === 1) {
                return this._startNative(filename, serial);
            } else {
                this._startBrowser(filename, serial);
            }
        }).catch(error => this._failNative(serial, error));
    }

    _ensurePlayListener() {
        if (this._playListenerInstalled) return;
        document.addEventListener('play', this._onDocumentPlay, true);
        this._playListenerInstalled = true;
    }

    _isCurrent(serial) { return !this._destroyed && serial === this._serial && this.isActive(); }

    _startBrowser(filename, serial) {
        this._route = 'browser';
        const audio = this._ensureAudio();

        // A suspended AudioContext (autoplay policy) plays silently — resume it.
        // On touch, start() runs inside the tap handler, so this is a valid user
        // gesture for resume().
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            this._audioCtx.resume().catch(() => {});
        }

        this._applyVolume();

        audio.src = `${this._apiBase}/audio?file=${encodeURIComponent(filename)}`;
        audio.play().catch((e) => {
            // play() often rejects because the user already moved on. Only
            // clear state if this exact playback request is still active.
            if (this._isCurrent(serial)) {
                console.warn(`[${this._pluginName}] play() rejected:`, e);
                this._clear();
                this._emit('stop', 'play-rejected');
            }
        });
    }

    async _startNative(filename, serial) {
        this._route = 'native';
        const requestId = `song-preview-${globalThis.crypto.randomUUID()}`;
        this._nativeRequestId = requestId;
        this._nativeGeneration = null;
        this._nativeClock = { currentTime: 0, duration: 0 };
        try {
            const result = await this._nativeApi.startPreview({ requestId,
                url: `${this._apiBase}/audio?file=${encodeURIComponent(filename)}`, volume: this._volume });
            if (!this._isCurrent(serial)) {
                // A late accepted load must never revive a hover the user left.
                await this._nativeApi.stopPreview(requestId);
                return;
            }
            if (!result?.accepted || result.requestId !== requestId || !Number.isSafeInteger(result.generation)) {
                throw new Error('Native preview was not accepted');
            }
            this._nativeGeneration = result.generation;
            // The volume slider may have moved while native preparation ran.
            await this._nativeApi.setPreviewVolume({ requestId, volume: this._volume });
            if (this._isCurrent(serial)) void this._pollNative(serial);
        } catch (error) { this._failNative(serial, error); }
    }

    async _pollNative(serial) {
        try {
            const snapshot = await this._nativeApi.getPreviewSnapshot();
            if (!this._isCurrent(serial)) return;
            if (snapshot?.requestId !== this._nativeRequestId || snapshot.generation !== this._nativeGeneration) {
                // A backing-song start/device change can stop the native player
                // before the renderer sees its host event. Never restart it.
                const stoppedFile = this.currentFile();
                this.stop('native-replaced');
                this._emit('failed', stoppedFile);
                return;
            }
            this._nativeClock.currentTime = Math.max(0, Number(snapshot.position) || 0);
            this._nativeClock.duration = Math.max(0, Number(snapshot.duration) || 0);
            if (snapshot.state === 'playing' && this._loadingFile) {
                this._playingFile = this._loadingFile;
                this._loadingFile = null;
                this._emit('play', this._playingFile, this._activeHost);
            } else if (snapshot.state === 'ended') {
                const finished = this.currentFile();
                this.stop('ended');
                this._emit('completed', finished);
                return;
            } else if (snapshot.state === 'failed') {
                throw new Error(snapshot.error || 'Native preview failed');
            } else if (snapshot.state === 'idle') {
                const stoppedFile = this.currentFile();
                this.stop('native-stopped');
                this._emit('failed', stoppedFile);
                return;
            }
            this._nativeTimer = setTimeout(() => {
                this._nativeTimer = null;
                if (this._isCurrent(serial)) void this._pollNative(serial);
            }, 100);
        } catch (error) { this._failNative(serial, error); }
    }

    _clearError() {
        this._errorNotice?.remove();
        this._errorNotice = null;
    }

    _failNative(serial, error) {
        if (!this._isCurrent(serial)) return;
        const file = this.currentFile();
        console.warn(`[${this._pluginName}] native preview failed:`, error);
        this.stop('native-error');
        // Gate hover retries until the user moves away. Keep failures visible
        // instead of silently returning to the stuttering browser route.
        this._emit('failed', file);
        const message = 'Song preview could not play. Try another song or check Audio settings.';
        if (typeof window.fbNotify?.show === 'function') {
            window.fbNotify.show({ title: 'Song preview unavailable', message, icon: '♪' });
        } else {
            const notice = document.createElement('div');
            notice.setAttribute('role', 'alert');
            notice.textContent = message;
            notice.style.cssText = 'position:fixed;bottom:20px;right:20px;max-width:360px;padding:12px;background:#252525;color:white;z-index:10000;border-radius:8px';
            document.body.appendChild(notice);
            this._errorNotice = notice;
        }
    }

    stop(reason = 'stop') {
        if (!this.isActive()) return;
        ++this._serial;
        if (this._nativeTimer !== null) clearTimeout(this._nativeTimer);
        this._nativeTimer = null;
        const requestId = this._nativeRequestId;
        this._nativeRequestId = null;
        this._nativeGeneration = null;
        if (requestId) Promise.resolve().then(() => this._nativeApi.stopPreview(requestId)).catch(error => {
            console.warn(`[${this._pluginName}] native preview stop failed:`, error);
        });
        const audio = this._audio;
        this._route = null;
        // pause() alone leaves a partially-buffered stream that can keep
        // leaking audio. removeAttribute('src') + load() aborts any pending
        // fetch and fully resets the element.
        if (audio) {
            audio.pause();
            audio.removeAttribute('src');
            try { audio.load(); } catch (_) { /* paranoia */ }
        }
        this._clear();
        this._emit('stop', reason);
    }

    destroy() {
        if (this.isActive()) this.stop('destroy');
        this._destroyed = true;
        this._clearError();
        window.removeEventListener('storage', this._onStorage);
        if (this._playListenerInstalled) {
            document.removeEventListener('play', this._onDocumentPlay, true);
            this._playListenerInstalled = false;
        }
        if (this._audio) {
            try {
                this._audio.pause();
                this._audio.removeAttribute('src');
                this._audio.load();
                this._audio.remove();
            } catch (_) {}
            this._audio = null;
        }
        if (this._audioCtx) {
            try { this._audioCtx.close(); } catch (_) {}
            this._audioCtx = null;
            this._sourceNode = null;
            this._gainNode = null;
        }
        this._externalAudioActive = false;
        for (const k of Object.keys(this._listeners)) this._listeners[k].length = 0;
    }
}
