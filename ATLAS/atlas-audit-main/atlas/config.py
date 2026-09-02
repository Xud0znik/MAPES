"""Configuration file (conf.json) for atlas."""

import json
import os

DEFAULTS = {
    "host": "127.0.0.1",
    "port": 8777,
    "tls": False,
    "cert": "",
    "key": "",
    "session_hours": 12,
    "allowed_hosts": [],
}

DEPRECATED = {"username": "", "password": ""}

KNOWN = set(DEFAULTS) | set(DEPRECATED)


class ConfigError(Exception):
    """conf.json exists but cannot be used."""


def path_for(base):
    return os.path.join(base, "conf.json")


def load(base):
    """Read conf.json from `base`. Returns (config_dict, warnings_list)."""
    cfg = dict(DEFAULTS)
    cfg.update(DEPRECATED)
    cfg["_tls_explicit"] = False
    warnings = []
    p = path_for(base)
    if not os.path.isfile(p):
        return cfg, warnings

    try:
        with open(p, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except ValueError as e:
        raise ConfigError("conf.json is not valid JSON: %s" % e)
    except OSError as e:
        raise ConfigError("conf.json cannot be read: %s" % e)

    if not isinstance(raw, dict):
        raise ConfigError("conf.json must contain a JSON object")

    for k, v in raw.items():
        if k not in KNOWN:
            warnings.append("unknown option %r in conf.json (ignored)" % k)
            continue
        cfg[k] = v
    cfg["_tls_explicit"] = "tls" in raw
    for k in DEPRECATED:
        if k in raw and raw[k]:
            warnings.append(
                "%r in conf.json is deprecated: credentials now live in the database "
                "(python3 atlas.py --setup)" % k)

    try:
        cfg["port"] = int(cfg["port"])
    except (TypeError, ValueError):
        raise ConfigError("port must be a number, got %r" % (cfg["port"],))
    if not (0 < cfg["port"] < 65536):
        raise ConfigError("port must be between 1 and 65535, got %d" % cfg["port"])
    try:
        cfg["session_hours"] = float(cfg["session_hours"])
    except (TypeError, ValueError):
        raise ConfigError("session_hours must be a number, got %r" % (cfg["session_hours"],))
    for k in ("host", "username", "password", "cert", "key"):
        if not isinstance(cfg[k], str):
            raise ConfigError("%s must be a string, got %r" % (k, cfg[k]))
    if not isinstance(cfg["tls"], bool):
        raise ConfigError("tls must be true or false, got %r" % (cfg["tls"],))
    if not (isinstance(cfg["allowed_hosts"], list)
            and all(isinstance(h, str) for h in cfg["allowed_hosts"])):
        raise ConfigError("allowed_hosts must be a list of strings, got %r" % (cfg["allowed_hosts"],))

    return cfg, warnings

