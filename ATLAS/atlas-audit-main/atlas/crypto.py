"""Authenticated encryption for the data kept at rest."""

import base64
import binascii
import hashlib
import hmac
import os
import secrets
import struct

PREFIX = "enc:v1:"
NONCE_LEN = 12
TAG_LEN = 16
KEY_LEN = 32
KDF_ROUNDS = 240000


class DecryptError(Exception):
    """The value could not be decrypted: wrong key, or the data was altered."""


def _load_fast_backend():
    """Return ChaCha20-Poly1305 from `cryptography`, or None if unusable."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
        probe = ChaCha20Poly1305(b"\x00" * KEY_LEN)
        probe.decrypt(b"\x00" * NONCE_LEN,
                      probe.encrypt(b"\x00" * NONCE_LEN, b"x", None), None)
        return ChaCha20Poly1305
    except Exception:
        return None


_FAST = _load_fast_backend()


def backend_name():
    return "cryptography" if _FAST else "python"


_SIGMA = (0x61707865, 0x3320646E, 0x79622D32, 0x6B206574)
_MASK = 0xFFFFFFFF
_ROUNDS = ((0, 4, 8, 12), (1, 5, 9, 13), (2, 6, 10, 14), (3, 7, 11, 15),
           (0, 5, 10, 15), (1, 6, 11, 12), (2, 7, 8, 13), (3, 4, 9, 14))
_P130_5 = (1 << 130) - 5
_CLAMP = 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF


def _rotl(v, n):
    return ((v << n) | (v >> (32 - n))) & _MASK


def _block(key, counter, nonce):
    """One 64-byte ChaCha20 keystream block."""
    state = (list(_SIGMA) + list(struct.unpack("<8I", key))
             + [counter & _MASK] + list(struct.unpack("<3I", nonce)))
    x = list(state)
    for _ in range(10):
        for a, b, c, d in _ROUNDS:
            x[a] = (x[a] + x[b]) & _MASK
            x[d] = _rotl(x[d] ^ x[a], 16)
            x[c] = (x[c] + x[d]) & _MASK
            x[b] = _rotl(x[b] ^ x[c], 12)
            x[a] = (x[a] + x[b]) & _MASK
            x[d] = _rotl(x[d] ^ x[a], 8)
            x[c] = (x[c] + x[d]) & _MASK
            x[b] = _rotl(x[b] ^ x[c], 7)
    return struct.pack("<16I", *[(x[i] + state[i]) & _MASK for i in range(16)])


def _chacha20(key, counter, nonce, data):
    """XOR `data` with the keystream starting at block `counter`."""
    out = bytearray(len(data))
    for off in range(0, len(data), 64):
        ks = _block(key, counter + off // 64, nonce)
        for i, byte in enumerate(data[off:off + 64]):
            out[off + i] = byte ^ ks[i]
    return bytes(out)


def _poly1305(msg, key):
    """The Poly1305 one-time authenticator over `msg` with a 32-byte key."""
    r = int.from_bytes(key[:16], "little") & _CLAMP
    s = int.from_bytes(key[16:32], "little")
    acc = 0
    for off in range(0, len(msg), 16):
        chunk = msg[off:off + 16]
        acc = ((acc + int.from_bytes(chunk + b"\x01", "little")) * r) % _P130_5
    return ((acc + s) & ((1 << 128) - 1)).to_bytes(16, "little")


def _pad16(data):
    rem = len(data) % 16
    return b"\x00" * (16 - rem) if rem else b""


def _mac(key, nonce, ct, aad):
    poly_key = _block(key, 0, nonce)[:32]
    data = (aad + _pad16(aad) + ct + _pad16(ct)
            + struct.pack("<Q", len(aad)) + struct.pack("<Q", len(ct)))
    return _poly1305(data, poly_key)


def _seal_py(key, nonce, plaintext, aad=b""):
    ct = _chacha20(key, 1, nonce, plaintext)
    return ct, _mac(key, nonce, ct, aad)


def _open_py(key, nonce, ct, tag, aad=b""):
    if not hmac.compare_digest(_mac(key, nonce, ct, aad), tag):
        raise DecryptError("authentication failed")
    return _chacha20(key, 1, nonce, ct)


def seal(key, plaintext, aad=b""):
    """Encrypt bytes. Returns nonce || tag || ciphertext."""
    if len(key) != KEY_LEN:
        raise ValueError("key must be %d bytes" % KEY_LEN)
    nonce = secrets.token_bytes(NONCE_LEN)
    if _FAST:
        blob = _FAST(key).encrypt(nonce, plaintext, aad or None)
        ct, tag = blob[:-TAG_LEN], blob[-TAG_LEN:]
    else:
        ct, tag = _seal_py(key, nonce, plaintext, aad)
    return nonce + tag + ct


def unseal(key, blob, aad=b""):
    """Decrypt a nonce || tag || ciphertext blob. Raises DecryptError."""
    if len(key) != KEY_LEN:
        raise ValueError("key must be %d bytes" % KEY_LEN)
    if len(blob) < NONCE_LEN + TAG_LEN:
        raise DecryptError("ciphertext is truncated")
    nonce = blob[:NONCE_LEN]
    tag = blob[NONCE_LEN:NONCE_LEN + TAG_LEN]
    ct = blob[NONCE_LEN + TAG_LEN:]
    if _FAST:
        try:
            return _FAST(key).decrypt(nonce, ct + tag, aad or None)
        except Exception as e:
            raise DecryptError("authentication failed") from e
    return _open_py(key, nonce, ct, tag, aad)


def derive_kek(password, salt, rounds=KDF_ROUNDS):
    """The key-encryption key derived from a password."""
    return hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"),
                               salt, rounds, dklen=KEY_LEN)


def new_dek():
    return secrets.token_bytes(KEY_LEN)


def new_salt():
    return os.urandom(16)


def wrap_dek(dek, password, salt, rounds=KDF_ROUNDS):
    """Seal the data key under the password. Returns the stored text form."""
    kek = derive_kek(password, salt, rounds)
    return PREFIX + base64.b64encode(seal(kek, dek)).decode("ascii")


def unwrap_dek(wrapped, password, salt, rounds=KDF_ROUNDS):
    """Recover the data key. Raises DecryptError on a wrong password."""
    dek = unseal(derive_kek(password, salt, rounds), _decode(wrapped))
    if len(dek) != KEY_LEN:
        raise DecryptError("wrapped key has the wrong length")
    return dek


def is_encrypted(value):
    return isinstance(value, str) and value.startswith(PREFIX)


def _decode(value):
    if not is_encrypted(value):
        raise DecryptError("value is not an atlas ciphertext")
    try:
        return base64.b64decode(value[len(PREFIX):], validate=True)
    except (binascii.Error, ValueError) as e:
        raise DecryptError("ciphertext is not valid base64") from e


def encrypt_text(dek, text):
    """Encrypt a field value. An empty value is left as it is."""
    if text is None or text == "":
        return text
    if not isinstance(text, str):
        text = str(text)
    return PREFIX + base64.b64encode(seal(dek, text.encode("utf-8"))).decode("ascii")


def decrypt_text(dek, value):
    """Decrypt a field value, passing plain text from older databases through."""
    if not is_encrypted(value):
        return value
    return unseal(dek, _decode(value)).decode("utf-8", "replace")
