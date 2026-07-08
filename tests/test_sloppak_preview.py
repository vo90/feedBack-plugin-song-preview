"""_read_sloppak_preview / _sloppak_preview_ogg: dir + zip forms, traversal
defense, size cap. Module-level, no setup() required."""

import zipfile

import routes


def _write_dir_sloppak(base, preview_rel="preview.ogg", preview_bytes=b"OGGDATA"):
    pack = base / "song.sloppak"
    pack.mkdir()
    (pack / "manifest.yaml").write_text(f"schema: 1\npreview: {preview_rel}\n", encoding="utf-8")
    if preview_bytes is not None:
        target = pack / preview_rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(preview_bytes)
    return pack


def _write_zip_sloppak(base, name="song.sloppak", preview_rel="preview.ogg", preview_bytes=b"OGGDATA"):
    path = base / name
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.yaml", f"schema: 1\npreview: {preview_rel}\n")
        if preview_bytes is not None:
            zf.writestr(preview_rel, preview_bytes)
    return path


def test_dir_sloppak_with_preview(tmp_path):
    pack = _write_dir_sloppak(tmp_path)
    assert routes._read_sloppak_preview(pack) == b"OGGDATA"


def test_zip_sloppak_with_preview(tmp_path):
    pack = _write_zip_sloppak(tmp_path)
    assert routes._read_sloppak_preview(pack) == b"OGGDATA"


def test_missing_manifest_returns_none(tmp_path):
    pack = tmp_path / "empty.sloppak"
    pack.mkdir()
    assert routes._read_sloppak_preview(pack) is None


def test_manifest_without_preview_key_returns_none(tmp_path):
    pack = tmp_path / "song.sloppak"
    pack.mkdir()
    (pack / "manifest.yaml").write_text("schema: 1\n", encoding="utf-8")
    assert routes._read_sloppak_preview(pack) is None


def test_dir_form_rejects_absolute_and_traversal_preview_path(tmp_path):
    pack = tmp_path / "song.sloppak"
    pack.mkdir()
    outside = tmp_path / "secret.ogg"
    outside.write_bytes(b"SECRET")
    for rel in ("/etc/passwd", "../secret.ogg", "..\\secret.ogg"):
        (pack / "manifest.yaml").write_text(f"schema: 1\npreview: {rel!r}\n", encoding="utf-8")
        assert routes._read_sloppak_preview(pack) is None


def test_dir_form_rejects_symlink_escape(tmp_path):
    outside = tmp_path / "secret.ogg"
    outside.write_bytes(b"SECRET")
    pack = tmp_path / "song.sloppak"
    pack.mkdir()
    link = pack / "preview.ogg"
    try:
        link.symlink_to(outside)
    except OSError:
        import pytest
        pytest.skip("symlinks unsupported in this environment")
    (pack / "manifest.yaml").write_text("schema: 1\npreview: preview.ogg\n", encoding="utf-8")
    # relative_to() on the resolved symlink target escapes the sloppak dir.
    assert routes._read_sloppak_preview(pack) is None


def test_dir_form_rejects_oversized_preview(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "_MAX_PREVIEW_BYTES", 4)
    pack = _write_dir_sloppak(tmp_path, preview_bytes=b"toolongdata")
    assert routes._read_sloppak_preview(pack) is None


def test_zip_form_rejects_traversal_preview_path(tmp_path):
    path = tmp_path / "song.sloppak"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.yaml", "schema: 1\npreview: ../evil.ogg\n")
    assert routes._read_sloppak_preview(path) is None


def test_zip_form_rejects_oversized_preview(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "_MAX_PREVIEW_BYTES", 4)
    path = _write_zip_sloppak(tmp_path, preview_bytes=b"toolongdata")
    assert routes._read_sloppak_preview(path) is None


def test_zip_form_missing_preview_entry_returns_none(tmp_path):
    path = tmp_path / "song.sloppak"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.yaml", "schema: 1\npreview: preview.ogg\n")
        # No preview.ogg entry actually written.
    assert routes._read_sloppak_preview(path) is None


def test_corrupt_zip_returns_none(tmp_path):
    path = tmp_path / "song.sloppak"
    path.write_bytes(b"not a zip file")
    assert routes._read_sloppak_preview(path) is None


def test_sloppak_preview_ogg_caches_and_reuses(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, "_cache_dir", None)
    monkeypatch.setattr(routes, "_context", {"config_dir": str(tmp_path / "cfg")})
    pack = _write_dir_sloppak(tmp_path)

    out1 = routes._sloppak_preview_ogg(pack)
    assert out1.is_file()
    assert out1.read_bytes() == b"OGGDATA"

    mtime1 = out1.stat().st_mtime
    out2 = routes._sloppak_preview_ogg(pack)
    assert out2 == out1  # same cache key -> same path, no re-extraction needed


def test_sloppak_preview_ogg_404s_without_preview(tmp_path, monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setattr(routes, "_cache_dir", None)
    monkeypatch.setattr(routes, "_context", {"config_dir": str(tmp_path / "cfg")})
    pack = tmp_path / "song.sloppak"
    pack.mkdir()
    (pack / "manifest.yaml").write_text("schema: 1\n", encoding="utf-8")

    try:
        routes._sloppak_preview_ogg(pack)
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 404
