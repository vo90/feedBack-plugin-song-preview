"""_evict_cache LRU behavior and _resolve_dlc_path traversal defense.
Module-level, no setup() required."""

import time

import pytest
from fastapi import HTTPException

import routes


def _touch(path, size, age_offset):
    path.write_bytes(b"x" * size)
    t = time.time() - age_offset
    import os
    os.utime(path, (t, t))


def test_evict_cache_removes_oldest_first_until_under_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "_cache_dir", tmp_path)
    _touch(tmp_path / "a.ogg", 100, age_offset=300)  # oldest
    _touch(tmp_path / "b.ogg", 100, age_offset=200)
    _touch(tmp_path / "c.ogg", 100, age_offset=100)  # newest

    routes._evict_cache(max_bytes=150)

    remaining = {p.name for p in tmp_path.glob("*.ogg")}
    assert "a.ogg" not in remaining
    assert "c.ogg" in remaining


def test_evict_cache_noop_under_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "_cache_dir", tmp_path)
    _touch(tmp_path / "a.ogg", 100, age_offset=10)
    routes._evict_cache(max_bytes=1000)
    assert (tmp_path / "a.ogg").exists()


def test_evict_cache_tolerates_missing_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "_cache_dir", tmp_path / "nope")
    routes._evict_cache(max_bytes=10)  # should not raise


def test_get_cache_dir_uses_config_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "_cache_dir", None)
    monkeypatch.setattr(routes, "_context", {"config_dir": str(tmp_path)})
    cache = routes._get_cache_dir()
    assert cache == tmp_path / "song_preview_cache"
    assert cache.is_dir()


def test_resolve_dlc_path_requires_file_param(monkeypatch):
    monkeypatch.setattr(routes, "_context", {"get_dlc_dir": lambda: "/tmp"})
    with pytest.raises(HTTPException) as exc:
        routes._resolve_dlc_path("")
    assert exc.value.status_code == 400


def test_resolve_dlc_path_rejects_absolute_and_traversal(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, "_context", {"get_dlc_dir": lambda: str(tmp_path)})
    for bad in ("/etc/passwd", "../escape.sloppak", "a/../../b.sloppak"):
        with pytest.raises(HTTPException) as exc:
            routes._resolve_dlc_path(bad)
        assert exc.value.status_code == 400


def test_resolve_dlc_path_requires_dlc_configured():
    routes._context = {}
    with pytest.raises(HTTPException) as exc:
        routes._resolve_dlc_path("song.sloppak")
    assert exc.value.status_code == 503


def test_resolve_dlc_path_404s_on_missing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, "_context", {"get_dlc_dir": lambda: str(tmp_path)})
    with pytest.raises(HTTPException) as exc:
        routes._resolve_dlc_path("nope.sloppak")
    assert exc.value.status_code == 404


def test_resolve_dlc_path_returns_full_path_for_valid_file(monkeypatch, tmp_path):
    (tmp_path / "song.sloppak").mkdir()
    monkeypatch.setattr(routes, "_context", {"get_dlc_dir": lambda: str(tmp_path)})
    resolved = routes._resolve_dlc_path("song.sloppak")
    assert resolved == (tmp_path / "song.sloppak").resolve()
