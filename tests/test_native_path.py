"""Native path discovery must never reveal arbitrary or remotely requested paths."""
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes
from conftest import _load_sibling


@pytest.fixture
def native_app(config_dir, dlc_dir, monkeypatch):
    monkeypatch.setattr(routes, "_cache_dir", None)
    app = FastAPI()
    routes.setup(app, {"config_dir": str(config_dir), "get_dlc_dir": lambda: str(dlc_dir),
                       "load_sibling": _load_sibling})
    return app


def make_pack(dlc_dir):
    pack = dlc_dir / "song.feedpak"
    pack.mkdir()
    (pack / "manifest.yaml").write_text("schema: 1\npreview: preview.ogg\n", encoding="utf-8")
    (pack / "preview.ogg").write_bytes(b"OGGDATA" * 200)
    return pack


@pytest.mark.parametrize("peer", ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
def test_local_native_path_returns_prepared_cache_only(native_app, dlc_dir, peer):
    make_pack(dlc_dir)
    with TestClient(native_app, client=(peer, 1234)) as client:
        response = client.get("/api/plugins/song_preview/native-path", params={"file": "song.feedpak"})
    assert response.status_code == 200
    result = Path(response.json()["path"])
    assert result.is_absolute() and result.is_file()
    result.relative_to(routes._get_cache_dir().resolve())
    assert result.read_bytes() == b"OGGDATA" * 200
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("peer", ["192.168.1.2", "198.51.100.1", "::ffff:192.168.1.2", "localhost", "testclient"])
def test_remote_client_and_spoofed_headers_cannot_discover_paths(native_app, peer, monkeypatch):
    def forbidden(_):
        pytest.fail("remote request reached disk preparation")
    monkeypatch.setattr(routes, "_prepare_preview", forbidden)
    with TestClient(native_app, client=(peer, 1234)) as client:
        response = client.get("/api/plugins/song_preview/native-path", params={"file": "song.feedpak"},
                              headers={"host": "127.0.0.1", "x-forwarded-for": "127.0.0.1"})
    assert response.status_code == 403


@pytest.mark.parametrize("file", ["../outside.feedpak", "a/../../outside.feedpak", "C:/outside.feedpak", "/outside.feedpak"])
def test_native_path_rejects_traversal_and_absolute_paths(native_app, file):
    with TestClient(native_app, client=("127.0.0.1", 1234)) as client:
        response = client.get("/api/plugins/song_preview/native-path", params={"file": file})
    assert response.status_code == 400


def test_native_path_rejects_prepared_result_outside_cache(native_app, tmp_path, monkeypatch):
    outside = tmp_path / "outside.ogg"
    outside.write_bytes(b"private")
    monkeypatch.setattr(routes, "_prepare_preview", lambda _: outside)
    with TestClient(native_app, client=("127.0.0.1", 1234)) as client:
        response = client.get("/api/plugins/song_preview/native-path", params={"file": "song.feedpak"})
    assert response.status_code == 500
    assert str(outside) not in response.text


def test_native_path_missing_clip_matches_browser_404(native_app, dlc_dir):
    pack = make_pack(dlc_dir)
    (pack / "manifest.yaml").write_text("schema: 1\n", encoding="utf-8")
    with TestClient(native_app, client=("127.0.0.1", 1234)) as client:
        assert client.get("/api/plugins/song_preview/native-path", params={"file": "song.feedpak"}).status_code == 404
        assert client.get("/api/plugins/song_preview/audio", params={"file": "song.feedpak"}).status_code == 404
