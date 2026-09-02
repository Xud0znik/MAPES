"""At-rest encryption for credential secrets stored in the Vault/Credentials
section. There's no login/master-password in MAPES (by design - it's meant
to just run without asking anything), so this protects against a leaked or
synced .db file being read in plain text, not against someone with full
access to the machine the key file sits on."""
import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

from .paths import app_dir

KEY_PATH = app_dir() / "secret.key"
PREFIX = "enc:v1:"


def _load_key():
    if KEY_PATH.exists():
        return KEY_PATH.read_bytes()
    key = os.urandom(32)
    try:
        KEY_PATH.write_bytes(key)
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
