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
    for setup() to succeed: just import the real module by file path."""
    path = Path(__file__).resolve().parent.parent / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"song_preview_{name}", path)
    mod = importlib.util.module_from_spec(spec)
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
