"""Shared mapes_config.json read/write (used by the entry point at startup
and by the /api/system/data-location endpoint at runtime)."""
import json

from .paths import app_dir

CONFIG_PATH = app_dir() / "mapes_config.json"


def load_config():
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    return {}


def save_config(cfg):
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
