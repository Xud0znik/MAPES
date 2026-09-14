"""At-rest encryption for credential secrets stored in the Vault/Credentials
section. There's no login/master-password in MAPES (by design - it's meant
to just run without asking anything), so this protects against a leaked or
synced .db file being read in plain text, not against someone with full
access to the machine the key file sits on."""
import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

from . import db
from .paths import app_dir

PREFIX = "enc:v1:"

# The key lives next to mapes.db/captures/ (db.DATA_DIR - looked up fresh on
# every call, since db.configure() can repoint it after this module is
# imported), not next to the app - everything a board needs (its data,
# attachments, and the key that decrypts its credential secrets) has to
# move together if the data folder ever does (Save As, MAPES_DATA_DIR, a
# different machine). _legacy_key_path() is where it used to live, kept
# only so an existing install migrates its key in place instead of losing
# access to already-encrypted secrets.
def _key_path():
    return db.DATA_DIR / "secret.key"


def _legacy_key_path():
    return app_dir() / "secret.key"


def _load_key():
    path = _key_path()
    if path.exists():
        return path.read_bytes()
    legacy = _legacy_key_path()
    if legacy != path and legacy.exists():
        try:
            key = legacy.read_bytes()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(key)
            legacy.unlink(missing_ok=True)
            return key
        except OSError:
            return legacy.read_bytes()
    key = os.urandom(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(key)
    except OSError:
        pass
    return key


def encrypt(plaintext):
    if not plaintext:
        return ""
    key = _load_key()
    nonce = os.urandom(12)
    ct = ChaCha20Poly1305(key).encrypt(nonce, plaintext.encode("utf-8"), None)
    return PREFIX + base64.urlsafe_b64encode(nonce + ct).decode("ascii")


def decrypt(value):
    if not value:
        return ""
    if not value.startswith(PREFIX):
        return value  # not encrypted (e.g. imported from elsewhere) - show as-is
    key = _load_key()
    raw = base64.urlsafe_b64decode(value[len(PREFIX):].encode("ascii"))
    nonce, ct = raw[:12], raw[12:]
    try:
        return ChaCha20Poly1305(key).decrypt(nonce, ct, None).decode("utf-8")
    except Exception:
        return ""
