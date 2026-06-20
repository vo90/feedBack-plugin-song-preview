# Song Preview

*A plugin that no-one asked for? Anyway, here's ~~Wonderwall~~ **Song Preview**!*

Hear a preview of songs in your library as you browse them. On desktop, just hover and listen — no buttons, no clicking. On your phone? A single tap does the job.

---

## Features

* **Audio Previews:** Instantly hear snippets just by hovering over your tracks (or tapping, on a touchscreen). Arrow-key through the library and the focused card previews automatically too — same hover-to-listen behaviour, no mouse required.

* **Runs on fee[dB]ack:** Works on the redesigned v0.3.0 UI — which added a brand-new **Songs** library screen with different internals — as well as the classic UI. Hover-to-listen, the progress trace, the "now playing" highlight, touch play buttons, and per-card **Fix** all work on both; no setup, it just detects which library it's looking at.

* **Fix Missing Previews:** Got Feedpaks with no preview — older conversions, or tracks that never had one? The plugin finds them all and sorts them out for you. Open **Song Preview** from the Plugins menu to see what's missing, then hit **Fix All** — or fix them one at a time straight from a song's card. Each fix generates a fresh ~30-second snippet from the song's own audio (starting near the first vocal or the catchiest part, with a short fade in and out), with a progress bar so you can watch it happen. *(Loose-folder songs don't need fixing — there's nothing to bake into, so they just generate-on-hover instead and won't show up in this list.)*

* **Works on Your Phone:** No hover on a touchscreen, so each song gets a little play button — tap to preview, tap again to stop, or just scroll away and it stops itself. Desktop stays pure hover-to-listen; the buttons only show up on touch devices.

* **Progress Indicator:** A clean accent-coloured trace shows how much of the clip is left at a glance. In grid view it rings the album art; in list view it traces the row itself — and the playing row lights up so you can see exactly which track is sounding. Auto-matches your theme accent.

* **Volume Control:** Are your ears being blown off by the previews? They have their own **Preview Volume** slider — find it on the plugin screen, completely separate from the song mixer. Drag it to your liking. It's loudness only, so it won't fully mute — flip the on/off toggle for that.

* **Built to be safe:** The preview & back-fill pipeline guards against maliciously-crafted Feedpaks (path-traversal and oversized-file protection), so a dodgy file can't trick it into reading something it shouldn't.

* **Supported Formats:** feedBack `.feedpak` files (zip or folder form) **and loose-folder songs** (a directory with `audio.wem` + arrangement XMLs). Feedpaks carry a baked-in preview clip; loose folders don't have one to bake, so the plugin generates a preview from the folder's own audio the first time you hover, then caches it — the first hover on a loose song may take a moment while it converts, after that it's instant.

* **On/Off Toggle:** Find it on the Song Preview screen, opened from the **Plugins** menu. Red = off, green = on. Defaults to on, and your choice survives plugin updates.



## License

[AGPL-3.0-only](LICENSE.md)
