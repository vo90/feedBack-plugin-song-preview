import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/audio-controller.js', import.meta.url), 'utf8')
    .replace('export class AudioController', 'class AudioController') + '\nglobalThis.Controller = AudioController;';
const loopSource = fs.readFileSync(new URL('../js/preview-loop.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/m, '').replace('export class PreviewLoop', 'class PreviewLoop')
    + '\nglobalThis.Loop = PreviewLoop;';
const settle = async () => { for (let i = 0; i < 30; ++i) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function harness({ native = true, touch = false } = {}) {
    const h = { starts: [], stops: [], volumes: [], notices: [], audio: [], timers: new Map(), events: [], generation: 0 };
    let uuid = 0, timer = 0;
    h.snapshot = { requestId: null, generation: 0, state: 'idle', position: 0, duration: 0 };
    h.api = {
        previewCapabilities: async () => ({ version: 1, native: true }),
        startPreview: async request => {
            h.starts.push(request);
            h.snapshot = { requestId: request.requestId, generation: ++h.generation,
                state: 'playing', position: 1.25, duration: 30, volume: request.volume };
            return { accepted: true, generation: h.generation, requestId: request.requestId };
        },
        stopPreview: async id => { h.stops.push(id); return true; },
        setPreviewVolume: async value => { h.volumes.push(value); return true; },
        getPreviewSnapshot: async () => ({ ...h.snapshot }),
    };
    const listeners = new Map();
    const document = {
        body: { appendChild() {} },
        addEventListener: (name, cb) => listeners.set(name, cb),
        removeEventListener: name => listeners.delete(name),
        createElement: tag => {
            const handlers = new Map();
            const el = { tag, style: {}, currentTime: 0, duration: 30, plays: 0, pauses: 0,
                addEventListener: (name, cb) => handlers.set(name, cb),
                emit: name => handlers.get(name)?.(),
                play() { this.plays++; return Promise.resolve(); },
                pause() { this.pauses++; }, load() {}, remove() {}, setAttribute() {},
                removeAttribute(name) { delete this[name]; } };
            if (tag === 'audio') h.audio.push(el);
            return el;
        },
    };
    const window = { addEventListener() {}, removeEventListener() {},
        matchMedia: () => ({ matches: touch }),
        fbNotify: { show: n => h.notices.push(n) },
        ...(native ? { feedBackDesktop: { audio: h.api } } : {}),
    };
    const context = vm.createContext({ window, document,
        localStorage: { getItem: () => null, setItem() {} },
        console: { warn() {} }, crypto: { randomUUID: () => String(++uuid) },
        setTimeout: cb => { h.timers.set(++timer, cb); return timer; },
        clearTimeout: id => h.timers.delete(id),
        fetch: async () => ({ status: 200 }),
    });
    vm.runInContext(source, context);
    h.context = context;
    h.controller = new context.Controller({ apiBase: '/api/plugins/song_preview', pluginName: 'song_preview' });
    for (const event of ['play', 'stop', 'completed', 'failed']) h.controller.on(event, (...args) => h.events.push([event, ...args]));
    h.externalPlay = () => listeners.get('play')?.({ target: {} });
    h.tick = async () => { const callbacks = [...h.timers.values()]; h.timers.clear(); callbacks.forEach(cb => cb()); await settle(); };
    return h;
}

test('native preview never starts browser audio and exposes the native progress clock', async () => {
    const h = harness();
    h.controller.start('some song.feedpak', { card: true }); await settle();
    assert.equal(h.audio.length, 0);
    assert.equal(h.starts[0].url, '/api/plugins/song_preview/audio?file=some%20song.feedpak');
    assert.equal(h.controller.currentFile(), 'some song.feedpak');
    assert.equal(h.controller.audioElement().currentTime, 1.25);
    assert.equal(h.controller.audioElement().duration, 30);
    assert.equal(h.events.filter(e => e[0] === 'play').length, 1);
    h.snapshot.position = 2.5; await h.tick();
    assert.equal(h.controller.audioElement().currentTime, 2.5);
    assert.equal(h.events.filter(e => e[0] === 'play').length, 1);
    h.controller.destroy();
});

test('rapid hover cancels capability discovery before any obsolete native start', async () => {
    const h = harness(), discovery = deferred();
    h.api.previewCapabilities = () => discovery.promise;
    h.controller.start('A.feedpak'); h.controller.start('B.feedpak');
    discovery.resolve({ version: 1, native: true }); await settle();
    assert.equal(h.starts.length, 1); assert.match(h.starts[0].url, /B.feedpak$/);
    h.controller.destroy();
});

test('late IPC acceptance after hover stop cannot revive preview or stop a replacement', async () => {
    const h = harness(), a = deferred();
    const realStart = h.api.startPreview;
    let old;
    h.api.startPreview = request => { if (!old) { old = request; h.starts.push(request); return a.promise; } return realStart(request); };
    h.controller.start('A.feedpak'); await settle();
    h.controller.start('B.feedpak'); await settle();
    const bId = h.starts[1].requestId;
    a.resolve({ accepted: true, requestId: old.requestId, generation: 99 }); await settle();
    assert.equal(h.controller.currentFile(), 'B.feedpak');
    assert.ok(h.stops.includes(old.requestId)); assert.ok(!h.stops.includes(bId));
    assert.deepEqual(h.events.filter(e => e[0] === 'play').map(e => e[1]), ['B.feedpak']);
    h.controller.destroy();
});

test('stale snapshot cannot complete or replace a newer hover', async () => {
    const h = harness(), delayed = deferred();
    h.controller.start('A.feedpak'); await settle();
    const realSnapshot = h.api.getPreviewSnapshot;
    h.api.getPreviewSnapshot = () => { h.api.getPreviewSnapshot = realSnapshot; return delayed.promise; };
    const polling = h.tick(); await settle();
    h.controller.start('B.feedpak'); await settle();
    delayed.resolve({ requestId: h.starts[0].requestId, generation: 1, state: 'ended' });
    await polling; await settle();
    // A's completion must neither finish B nor replace its progress clock.
    assert.equal(h.events.filter(e => e[0] === 'completed').length, 0);
    assert.equal(h.controller.currentFile(), 'B.feedpak');
    assert.equal(h.starts.length, 2);
    h.controller.destroy();
});

test('leaving before capability resolution does not start native or browser playback', async () => {
    const h = harness(), pending = deferred(); h.api.previewCapabilities = () => pending.promise;
    h.controller.start('A.feedpak'); h.controller.stop('no-target');
    pending.resolve({ version: 1, native: true }); await settle();
    assert.equal(h.starts.length, 0); assert.equal(h.audio.length, 0); assert.equal(h.timers.size, 0);
    h.controller.destroy();
});

test('native asynchronous decode failure and device stop both terminate polling', async () => {
    for (const state of ['failed', 'idle']) {
        const h = harness(); h.controller.start('A.feedpak'); await settle();
        h.snapshot.state = state; await h.tick();
        assert.equal(h.controller.isActive(), false); assert.equal(h.timers.size, 0);
        assert.equal(h.events.filter(e => e[0] === 'failed').length, 1);
        assert.equal(h.audio.length, 0); assert.equal(h.notices.length, state === 'failed' ? 1 : 0);
        h.controller.destroy();
    }
});

test('native failure is visible, gates retries, and never falls back to browser audio', async () => {
    const h = harness(); h.api.startPreview = async () => { throw new Error('decoder failure'); };
    h.controller.start('bad.feedpak'); await settle();
    assert.equal(h.controller.isActive(), false);
    assert.equal(h.notices.length, 1); assert.equal(h.audio.length, 0);
    assert.deepEqual(h.events.filter(e => e[0] === 'failed').map(e => e[1]), ['bad.feedpak']);
    h.controller.destroy();
});

test('native ended emits completion once and clears polling', async () => {
    const h = harness(); h.controller.start('A.feedpak'); await settle();
    h.snapshot.state = 'ended'; h.snapshot.position = 30; await h.tick(); await h.tick();
    assert.equal(h.controller.isActive(), false); assert.equal(h.timers.size, 0);
    assert.deepEqual(h.events.filter(e => e[0] === 'completed').map(e => e[1]), ['A.feedpak']);
    h.controller.destroy();
});

test('live and loading volume changes use the same request and latest level', async () => {
    const h = harness(), prepared = deferred(); let request;
    h.api.startPreview = r => { request = r; h.snapshot = { requestId: r.requestId, generation: 1, state: 'playing' }; return prepared.promise; };
    h.controller.start('A.feedpak'); await settle(); h.controller.setVolume(.7); await settle();
    prepared.resolve({ accepted: true, requestId: request.requestId, generation: 1 }); await settle();
    assert.equal(h.volumes.at(-1).volume, .7); assert.equal(h.volumes.at(-1).requestId, request.requestId);
    h.controller.setVolume(.4); await settle(); assert.equal(h.volumes.at(-1).volume, .4);
    h.controller.destroy();
});

test('host playback and plugin destruction cancel native preview', async () => {
    const h = harness(); h.controller.start('A.feedpak'); await settle(); h.externalPlay(); await settle();
    assert.equal(h.controller.isActive(), false); assert.equal(h.controller.isExternalAudioActive(), true);
    assert.equal(h.stops.at(-1), h.starts[0].requestId); assert.equal(h.timers.size, 0);
    h.controller.clearExternalAudio(); h.controller.start('B.feedpak'); await settle();
    h.controller.destroy(); await settle(); assert.equal(h.stops.at(-1), h.starts[1].requestId);
    h.controller.start('C.feedpak'); await settle(); assert.equal(h.starts.length, 2);
});

test('disabling previews or opening a menu stops native playback through the existing hover gates', async () => {
    for (const gate of ['disabled', 'menu']) {
        const h = harness(); vm.runInContext(loopSource, h.context);
        const state = { enabled: true, menu: false };
        const loop = new h.context.Loop({ audio: h.controller,
            toggle: { isEnabled: () => state.enabled },
            menu: { isAnyMenuOpen: () => state.menu }, scope: {},
            input: { onMouseMove() {}, onSuspend() {}, isSuspended: () => false } });
        h.controller.start('A.feedpak'); await settle();
        if (gate === 'disabled') state.enabled = false; else state.menu = true;
        loop._tick(); await settle();
        assert.equal(h.controller.isActive(), false);
        assert.equal(h.stops.at(-1), h.starts[0].requestId);
        loop.destroy(); h.controller.destroy();
    }
});

for (const touch of [false, true]) test(`browser fallback preserves immediate play gesture (touch=${touch})`, () => {
    const h = harness({ native: false, touch }); h.controller.start('A.feedpak');
    assert.equal(h.audio.length, 1); assert.equal(h.audio[0].plays, 1);
    h.audio[0].emit('playing'); assert.equal(h.controller.currentFile(), 'A.feedpak');
    h.controller.stop(); assert.equal(h.audio[0].pauses, 1); h.controller.destroy();
});

test('old Desktop without native capability keeps browser playback', async () => {
    const h = harness(); h.api.previewCapabilities = async () => ({ version: 0, native: false });
    h.controller.start('A.feedpak'); await settle();
    assert.equal(h.audio[0].plays, 1); assert.equal(h.starts.length, 0); h.controller.destroy();
});
