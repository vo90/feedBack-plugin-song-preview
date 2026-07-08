import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# The plugin is a flat module directory; make routes importable from tests.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import routes  # noqa: E402


def _load_sibling(name):
    """Mirrors the host's plugin-namespaced sibling loader closely enough
    for setup() to succeed: just import the real module by file path.

    Must register in sys.modules before exec_module — backfill.py uses
    `from __future__ import annotations` (deferred/string annotations),
    and its dataclasses resolve those strings via
    sys.modules[cls.__module__].__dict__ at decoration time. Skipping
    this registration leaves cls.__module__ pointing at a name absent
    from sys.modules, so ``sys.modules.get(cls.__module__)`` returns
    None and dataclass field resolution blows up with an
    AttributeError on 'NoneType' object.
    """
    mod_name = f"song_preview_{name}"
    path = Path(__file__).resolve().parent.parent / f"{name}.py"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def config_dir(tmp_path):
    return tmp_path / "config"


@pytest.fixture
def dlc_dir(tmp_path):
    d = tmp_path / "dlc"
    d.mkdir()
    return d


@pytest.fixture
def client(config_dir, dlc_dir):
    app = FastAPI()
    context = {
        "config_dir": str(config_dir),
        "get_dlc_dir": lambda: str(dlc_dir),
        "load_sibling": _load_sibling,
    }
    routes.setup(app, context)
    with TestClient(app) as c:
        yield c
