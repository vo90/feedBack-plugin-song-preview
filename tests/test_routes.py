"""FastAPI-wired routes: js static serving, backfill-status/progress."""


def test_get_js_serves_bundled_file(client):
    js_dir = None
    import routes
    from pathlib import Path
    js_dir = Path(routes.__file__).resolve().parent / "js"
    files = list(js_dir.glob("*.js")) if js_dir.is_dir() else []
    if not files:
        import pytest
        pytest.skip("no js/ files bundled in this checkout")
    r = client.get(f"/api/plugins/song_preview/js/{files[0].name}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/javascript")
    assert "etag" in r.headers


def test_get_js_304_on_matching_etag(client):
    import routes
    from pathlib import Path
    js_dir = Path(routes.__file__).resolve().parent / "js"
    files = list(js_dir.glob("*.js")) if js_dir.is_dir() else []
    if not files:
        import pytest
        pytest.skip("no js/ files bundled in this checkout")
    first = client.get(f"/api/plugins/song_preview/js/{files[0].name}")
    etag = first.headers["etag"]
    second = client.get(f"/api/plugins/song_preview/js/{files[0].name}",
                        headers={"if-none-match": etag})
    assert second.status_code == 304


def test_get_js_rejects_traversal_and_wrong_extension(client):
    for bad in ("..%2F..%2Frequirements.txt", "evil.py", "..%5C..%5Croutes.py"):
        assert client.get(f"/api/plugins/song_preview/js/{bad}").status_code in (400, 404)
    assert client.get("/api/plugins/song_preview/js/routes.txt").status_code == 400


def test_get_js_missing_file_404(client):
    assert client.get("/api/plugins/song_preview/js/nope.js").status_code == 404


def test_backfill_status_idle(client):
    r = client.get("/api/plugins/song_preview/backfill-status")
    assert r.status_code == 200
    body = r.json()
    assert body["running"] is False


def test_backfill_progress_idle_for_unknown_file(client):
    r = client.get("/api/plugins/song_preview/backfill-progress", params={"file": "nope.sloppak"})
    assert r.status_code == 200
    assert r.json() == {"stage": "idle", "progress": 0}


def test_audit_lists_sloppaks_missing_a_preview(client, dlc_dir):
    without_preview = dlc_dir / "no-preview.sloppak"
    without_preview.mkdir()
    (without_preview / "manifest.yaml").write_text("schema: 1\n", encoding="utf-8")

    with_preview = dlc_dir / "has-preview.sloppak"
    with_preview.mkdir()
    (with_preview / "manifest.yaml").write_text("schema: 1\npreview: preview.ogg\n", encoding="utf-8")
    # backfill._has_preview() only counts a preview present when the file is
    # over 100 bytes (guards against stub/truncated files), so pad it.
    (with_preview / "preview.ogg").write_bytes(b"OGGDATA" * 20)

    r = client.get("/api/plugins/song_preview/audit")
    assert r.status_code == 200
    body = r.json()
    missing = {e["filename"] for e in body["missing"]}
    assert "no-preview.sloppak" in missing
    assert "has-preview.sloppak" not in missing
    assert body["count"] == len(body["missing"])
