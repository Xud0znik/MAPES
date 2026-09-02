"""Authentication: one password, sessions and TLS material."""

import base64
import binascii
import hashlib
import hmac
import os
import secrets
import threading
import time

from . import crypto, db

PBKDF2_ROUNDS = 240000
_SCHEME = "pbkdf2_sha256"

MIN_PASSWORD = 8

_SESSIONS = {}
_LOCK = threading.Lock()

_FAILS = {}
MAX_FAILS = 8
LOCKOUT_SECONDS = 300


def hash_password(password, rounds=PBKDF2_ROUNDS, salt=None):
    """Encode a password as pbkdf2_sha256$rounds$salt$hash."""
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return "%s$%d$%s$%s" % (_SCHEME, rounds,
                            base64.b64encode(salt).decode("ascii"),
                            base64.b64encode(dk).decode("ascii"))


def is_hash(value):
    return isinstance(value, str) and value.startswith(_SCHEME + "$")


def verify_password(password, stored):
    """True if `password` matches `stored` (a hash, or plain text from conf.json)."""
    if not stored:
        return False
    if is_hash(stored):
        try:
            _, rounds, salt_b64, dk_b64 = stored.split("$", 3)
            rounds = int(rounds)
            salt = base64.b64decode(salt_b64)
            expected = base64.b64decode(dk_b64)
        except (ValueError, TypeError, binascii.Error):
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
        return hmac.compare_digest(dk, expected)
    a = hashlib.sha256(password.encode("utf-8")).digest()
    b = hashlib.sha256(stored.encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


def same_username(given, want):
    """Compare usernames in constant time, so no timing leak on the name."""
    return hmac.compare_digest(
        hashlib.sha256((given or "").encode("utf-8")).digest(),
        hashlib.sha256((want or "").encode("utf-8")).digest())


class AuthError(Exception):
    """The credentials given do not match the stored ones."""


class VaultLocked(Exception):
    """A secret has to be read or written but no password has unlocked the key."""


def load_auth():
    """The single app_auth row, or None when no password has been set up."""
    return db.row("SELECT * FROM app_auth WHERE id=1")


def configured():
    """True once a password exists in the database."""
    return load_auth() is not None


def create_auth(username, password, rounds=PBKDF2_ROUNDS):
    """Set up the password for the first time. Returns the new data key."""
    username = (username or "admin").strip() or "admin"
    if not password:
        raise ValueError("the password cannot be empty")
    dek = crypto.new_dek()
    salt = crypto.new_salt()
    now = time.time()
    db.execute(
        "INSERT INTO app_auth (id, username, pw_hash, kdf_salt, kdf_rounds,"
        " wrapped_dek, created_at, updated_at) VALUES (1,?,?,?,?,?,?,?)"
        " ON CONFLICT(id) DO UPDATE SET username=excluded.username,"
        " pw_hash=excluded.pw_hash, kdf_salt=excluded.kdf_salt,"
        " kdf_rounds=excluded.kdf_rounds, wrapped_dek=excluded.wrapped_dek,"
        " updated_at=excluded.updated_at",
        (username, hash_password(password, rounds), salt, rounds,
         crypto.wrap_dek(dek, password, salt, rounds), now, now))
    return dek


def verify_login(username, password):
    """Check a login. Returns the unwrapped data key, or raises AuthError."""
    row = load_auth()
    if row is None:
        raise AuthError("no password has been set up")
    ok_user = same_username(username, row["username"])
    ok_pass = verify_password(password or "", row["pw_hash"] or "")
    if not (ok_user and ok_pass):
        raise AuthError("wrong username or password")

    rounds = int(row["kdf_rounds"] or PBKDF2_ROUNDS)
    if not row["wrapped_dek"]:
        dek = crypto.new_dek()
        salt = crypto.new_salt()
        db.execute("UPDATE app_auth SET kdf_salt=?, kdf_rounds=?, wrapped_dek=?,"
                   " updated_at=? WHERE id=1",
                   (salt, rounds, crypto.wrap_dek(dek, password, salt, rounds), time.time()))
        return dek
    try:
        return crypto.unwrap_dek(row["wrapped_dek"], password, _as_bytes(row["kdf_salt"]), rounds)
    except crypto.DecryptError:
        raise AuthError("the password is right but the vault key does not match "
                        "(app_auth looks inconsistent)")


def change_password(current, new, username=None, rounds=PBKDF2_ROUNDS):
    """Re-seal the data key under a new password. Data is never rewritten."""
    if not new:
        raise ValueError("the new password cannot be empty")
    dek = verify_login(username_of(), current)
    row = load_auth()
    salt = crypto.new_salt()
    db.execute("UPDATE app_auth SET username=?, pw_hash=?, kdf_salt=?, kdf_rounds=?,"
               " wrapped_dek=?, updated_at=? WHERE id=1",
               (username or row["username"], hash_password(new, rounds), salt, rounds,
                crypto.wrap_dek(dek, new, salt, rounds), time.time()))
    return dek


def username_of():
    row = load_auth()
    return row["username"] if row else ""


def seed_from_config(cfg):
    """Adopt a password left in an old conf.json, so nobody is locked out."""
    stored = (cfg.get("password") or "").strip()
    if not stored or configured():
        return None
    username = (cfg.get("username") or "admin").strip() or "admin"
    now = time.time()
    if is_hash(stored):
        db.execute(
            "INSERT INTO app_auth (id, username, pw_hash, kdf_salt, kdf_rounds,"
            " wrapped_dek, created_at, updated_at) VALUES (1,?,?,?,?,'',?,?)",
            (username, stored, b"", PBKDF2_ROUNDS, now, now))
    else:
        create_auth(username, stored)
    return ("the conf.json password was moved into the database; delete it from "
            "the file and run: python3 atlas.py --change-password")


def _as_bytes(value):
    """SQLite hands a BLOB back as bytes, but a hand-edited row may be text."""
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    return b"" if value is None else bytes(value)


_VAULT = {"dek": None}


def unlock(dek):
    with _LOCK:
        _VAULT["dek"] = dek


def lock():
    with _LOCK:
        _VAULT["dek"] = None


def unlocked():
    with _LOCK:
        return _VAULT["dek"] is not None


def dek():
    """The data key, or None when the vault is locked."""
    with _LOCK:
        return _VAULT["dek"]


def encrypt_secret(value):
    """Encrypt a secret on its way into the database."""
    if not configured():
        return value
    key = dek()
    if key is None:
        raise VaultLocked("the vault is locked: sign in again")
    return crypto.encrypt_text(key, value)


def encrypt_vault_rows():
    """Encrypt every secret still stored as plain text. Returns how many moved."""
    if not configured() or dek() is None:
        raise VaultLocked("the vault is locked")
    moved = 0
    for r in db.rows("SELECT id, secret FROM creds"):
        if r["secret"] and not crypto.is_encrypted(r["secret"]):
            db.execute("UPDATE creds SET secret=? WHERE id=?",
                       (encrypt_secret(r["secret"]), r["id"]))
            moved += 1
    return moved


def plaintext_rows():
    """How many secrets are still stored as plain text."""
    n = 0
    for r in db.rows("SELECT secret FROM creds"):
        if r["secret"] and not crypto.is_encrypted(r["secret"]):
            n += 1
    return n


def decrypt_secret(value):
    """Decrypt a secret on its way out. Legacy plain text passes through."""
    if not crypto.is_encrypted(value):
        return value
    key = dek()
    if key is None:
        raise VaultLocked("the vault is locked: sign in again")
    try:
        return crypto.decrypt_text(key, value)
    except crypto.DecryptError:
        return "<undecryptable>"


def locked_out(ip):
    with _LOCK:
        fails, until = _FAILS.get(ip, (0, 0))
        if until and time.time() < until:
            return int(until - time.time())
        if until and time.time() >= until:
            _FAILS.pop(ip, None)
    return 0


def note_failure(ip):
    with _LOCK:
        fails, until = _FAILS.get(ip, (0, 0))
        fails += 1
        if fails >= MAX_FAILS:
            _FAILS[ip] = (0, time.time() + LOCKOUT_SECONDS)
        else:
            _FAILS[ip] = (fails, 0)


def note_success(ip):
    with _LOCK:
        _FAILS.pop(ip, None)


def new_session(hours):
    token = secrets.token_urlsafe(32)
    with _LOCK:
        _SESSIONS[token] = time.time() + hours * 3600
        _prune()
    return token


def valid_session(token):
    if not token:
        return False
    with _LOCK:
        exp = _SESSIONS.get(token)
        if exp is None:
            return False
        if time.time() > exp:
            _SESSIONS.pop(token, None)
            return False
    return True


def drop_session(token):
    with _LOCK:
        _SESSIONS.pop(token, None)


def any_session():
    """True while at least one session is still valid."""
    with _LOCK:
        _prune()
        return bool(_SESSIONS)


def drop_all_sessions():
    """Invalidate every session, so a password change signs every browser out."""
    with _LOCK:
        _SESSIONS.clear()


def _prune():
    now = time.time()
    for t in [t for t, e in _SESSIONS.items() if e < now]:
        _SESSIONS.pop(t, None)


class TLSUnavailable(Exception):
    """No certificate could be found or generated."""


def resolve_cert(cfg, data_dir):
    """Return (cert_path, key_path), generating a self-signed pair if needed."""
    cert, key = (cfg.get("cert") or "").strip(), (cfg.get("key") or "").strip()
    if cert or key:
        if not (cert and key):
            raise TLSUnavailable("conf.json sets only one of cert/key; both are required")
        if not os.path.isfile(cert):
            raise TLSUnavailable("certificate not found: %s" % cert)
        if not os.path.isfile(key):
            raise TLSUnavailable("private key not found: %s" % key)
        return cert, key

    cert = os.path.join(data_dir, "atlas-cert.pem")
    key = os.path.join(data_dir, "atlas-key.pem")
    if os.path.isfile(cert) and os.path.isfile(key):
        return cert, key

    _generate_selfsigned(cert, key)
    return cert, key


def _generate_selfsigned(cert_path, key_path):
    if _gen_with_cryptography(cert_path, key_path):
        return
    if _gen_with_openssl(cert_path, key_path):
        return
    raise TLSUnavailable(
        "no certificate available and none could be generated.\n"
        "    Install one of these, or point conf.json at your own cert/key:\n"
        "      pip install cryptography\n"
        "      apt install openssl\n"
        "    Or generate the pair by hand:\n"
        "      openssl req -x509 -newkey rsa:2048 -nodes -days 825 \\\n"
        "        -subj \"/CN=atlas\" -keyout %s -out %s" % (key_path, cert_path))


def _gen_with_cryptography(cert_path, key_path):
    try:
        import datetime
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        return False

    k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "atlas")])
    now = datetime.datetime.utcnow()
    san = x509.SubjectAlternativeName([
        x509.DNSName("localhost"),
        x509.IPAddress(__import__("ipaddress").ip_address("127.0.0.1")),
    ])
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(k.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(days=825))
            .add_extension(san, critical=False)
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(k, hashes.SHA256()))

    _write_private(key_path, k.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption()))
    with open(cert_path, "wb") as fh:
        fh.write(cert.public_bytes(serialization.Encoding.PEM))
    return True


def _gen_with_openssl(cert_path, key_path):
    import shutil
    import subprocess
    exe = shutil.which("openssl")
    if not exe:
        return False
    cmd = [exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
           "-subj", "/CN=atlas",
           "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
           "-keyout", key_path, "-out", cert_path]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, OSError):
        try:
            subprocess.run([c for c in cmd if c != "-addext"
                            and not c.startswith("subjectAltName=")],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.CalledProcessError, OSError):
            return False
    _chmod_private(key_path)
    return True


def _write_private(path, data):
    """Write a key file that only the current user can read."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def _chmod_private(path):
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
