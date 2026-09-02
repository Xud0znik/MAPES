"""atlas - an audit board for mapping out your pentests."""

import argparse
import os
import sys
import webbrowser

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

ATLAS_BIG = [
    " █████╗ ████████╗██╗      █████╗ ███████╗",
    "██╔══██╗╚══██╔══╝██║     ██╔══██╗██╔════╝",
    "███████║   ██║   ██║     ███████║███████╗",
    "██╔══██║   ██║   ██║     ██╔══██║╚════██║",
    "██║  ██║   ██║   ███████╗██║  ██║███████║",
    "╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝",
]
ATLAS_ASCII = [
    "    _   _____ _        _    ____",
    "   / \\ |_   _| |      / \\  / ___|",
    "  / _ \\  | | | |     / _ \\ \\___ \\",
    " / ___ \\ | | | |___ / ___ \\ ___) |",
    "/_/   \\_\\|_| |_____/_/   \\_\\____/",
]
AUTHOR = [
    ("author", "Zoyma"),
    ("github", "https://github.com/Zoyma"),
    ("linkedin", "https://www.linkedin.com/in/marc-teruel-ruiz-5a9515222"),
]

_REDS = ("\033[38;5;210m", "\033[38;5;203m", "\033[38;5;196m",
         "\033[38;5;160m", "\033[38;5;124m", "\033[38;5;88m")
_RESET, _BOLD, _DIM, _WARN = "\033[0m", "\033[1m", "\033[38;5;245m", "\033[1;33m"


def _use_color(stream=None):
    """Colour only on a real terminal: when redirected, plain text."""
    stream = stream or sys.stdout
    if os.environ.get("NO_COLOR") or os.environ.get("TERM") == "dumb":
        return False
    return bool(getattr(stream, "isatty", None) and stream.isatty())


def _printable(chunks):
    """True if the output encoding can handle these characters."""
    enc = getattr(sys.stdout, "encoding", None) or "ascii"
    try:
        "".join(chunks).encode(enc)
        return True
    except (UnicodeEncodeError, LookupError):
        return False


def banner():
    """ATLAS in large type (red gradient) with 'audit' underneath, plus author + links."""
    art = ATLAS_BIG if _printable(ATLAS_BIG) else ATLAS_ASCII
    color = _use_color()
    n = len(art)
    width = max(len(l) for l in art)

    out = []
    out.append("  " + (_DIM + "welcome to" + _RESET if color else "welcome to"))
    for i, line in enumerate(art):
        if color:
            out.append("  " + _REDS[min(len(_REDS) - 1, i * len(_REDS) // n)] + line + _RESET)
        else:
            out.append("  " + line)

    sub = "A U D I T".rjust(width)
    out.append("  " + (_DIM + sub + _RESET if color else sub))

    out.append("")
    w = max(len(k) for k, _ in AUTHOR)
    for k, v in AUTHOR:
        label = k.ljust(w)
        if color:
            val = (_BOLD + "\033[38;5;203m" + v + _RESET) if k == "author" else ("\033[38;5;252m" + v + _RESET)
            out.append("  " + _DIM + label + _RESET + "   " + val)
        else:
            out.append("  " + label + "   " + v)
    return "\n".join(out)


def db_corrupt_help(path, cause):
    """Explain what to do when the .db is damaged, instead of dumping a traceback."""
    warn = _WARN if _use_color(sys.stderr) else ""
    reset = _RESET if _use_color(sys.stderr) else ""
    return "\n".join([
        "  %s[!] the database is damaged and atlas cannot start%s" % (warn, reset),
        "",
        "  file     -> %s" % path,
        "  sqlite   -> %s" % cause,
        "",
        "  Usual cause: the ./data folder lives in OneDrive/Dropbox or is tracked",
        "  in git, and the .db was copied without its -wal / -shm files (or vice versa).",
        "",
        "  What to do:",
        "    1) Keep a copy just in case:",
        "         copy %s -> %s.bak" % (os.path.basename(path), os.path.basename(path)),
        "    2) If you still have the %s-wal and %s-shm files, put them back next to"
        % (os.path.basename(path), os.path.basename(path)),
        "       the .db and start again: SQLite reintegrates them on its own.",
        "    3) Otherwise, try to recover whatever is left:",
        "         sqlite3 %s \".recover\" | sqlite3 atlas-recovered.db" % path,
        "    4) To start from scratch, delete the .db (you lose the data) and start:",
        "         atlas creates it empty again.",
        "",
        "  Tip: move ./data out of the synced folder with --data, for example",
        "    python3 atlas.py --data ~/atlas-data",
        "",
    ])


def db_io_help(path, cause):
    """Help for when SQLite cannot operate on that filesystem ("disk I/O error")."""
    warn = _WARN if _use_color(sys.stderr) else ""
    reset = _RESET if _use_color(sys.stderr) else ""
    data_dir = os.path.dirname(path)
    lines = [
        "  %s[!] SQLite cannot work on this folder%s" % (warn, reset),
        "",
        "  file     -> %s" % path,
        "  sqlite   -> %s" % cause,
        "",
        "  The database is fine: it is the folder that fails. SQLite needs to lock",
        "  files, and atlas already tries every journal mode a location might",
        "  tolerate, so reaching this point means none of them are supported.",
        "  This happens on network drives (SMB/NFS), mounted folders and bridge",
        "  filesystems.",
        "",
        "  Fix: put the data on a local disk on the machine itself.",
        "",
        "    %s atlas.py --data %s" % (os.path.basename(sys.executable) or "python3",
                                      os.path.join("<local folder>", "atlas-data")),
        "",
        "  To take what you already have with you, copy the whole folder first:",
        "    %s -> <local folder>/atlas-data" % data_dir,
    ]
    if path.startswith("/mnt/") and _is_wsl():
        lines += [
            "",
            "  In your case you are on WSL reaching a Windows drive through /mnt",
            "  (drvfs), the usual suspect. Two options that work:",
            "",
            "    - keep the data on Linux:  atlas.py --data ~/atlas-data",
            "    - or start atlas from Windows (PowerShell/CMD) instead of WSL,",
            "      where the same folder works natively.",
        ]
    lines.append("")
    return "\n".join(lines)


def _is_wsl():
    """True on WSL 1 and 2. binfmt_misc is unreliable, /proc/version is not."""
    if os.path.exists("/proc/sys/fs/binfmt_misc/WSLInterop") or os.environ.get("WSL_DISTRO_NAME"):
        return True
    try:
        with open("/proc/version", "r") as fh:
            v = fh.read().lower()
        return "microsoft" in v or "wsl" in v
    except OSError:
        return False


def tls_help(cause):
    """TLS was requested but no certificate could be found or generated."""
    warn = _WARN if _use_color(sys.stderr) else ""
    reset = _RESET if _use_color(sys.stderr) else ""
    return "\n".join([
        "  %s[!] TLS is enabled but atlas has no certificate%s" % (warn, reset),
        "",
        "  %s" % cause,
        "",
        "  Once the pair exists, atlas reuses it on every start.",
        "  To run without encryption instead (only sensible on localhost):",
        "",
        "    python3 atlas.py --no-tls        # or set \"tls\": false in conf.json",
        "",
    ])


def _ask_line(prompt, default=""):
    try:
        got = input(prompt).strip()
    except EOFError:
        return default
    return got or default


def _ask_secret(prompt):
    import getpass
    try:
        return getpass.getpass(prompt)
    except EOFError:
        return ""


def _ask_new_password(min_len, allow_skip=False):
    """Ask for a password and its repeat, up to three times."""
    for _ in range(3):
        pw = _ask_secret("  password:        ")
        if not pw:
            if allow_skip:
                return None
            print("      the password cannot be empty")
            continue
        if len(pw) < min_len:
            print("      too short: at least %d characters" % min_len)
            continue
        if pw != _ask_secret("  repeat password: "):
            print("      they do not match, try again")
            continue
        return pw
    print("      giving up after three attempts")
    return None


def setup_intro():
    warn = _WARN if _use_color() else ""
    bold = _BOLD if _use_color() else ""
    reset = _RESET if _use_color() else ""
    print("")
    print("  %sSet the atlas password%s" % (bold, reset))
    print("  ----------------------")
    print("  One password does both jobs: it signs you in, and it encrypts every")
    print("  secret you loot into the vault.")
    print("")
    print("  %s[!] There is no recovery. Forget it and the secrets are gone.%s" % (warn, reset))
    print("")


def run_setup(auth):
    """--setup: ask for the username and password, store them, encrypt what exists."""
    if auth.configured():
        print("")
        print("  a password is already set for %s" % auth.username_of())
        print("  changing it re-seals the vault key, so stored secrets stay readable")
        print("")
        return run_change_password(auth)

    setup_intro()
    username = _ask_line("  username [admin]: ", "admin")
    pw = _ask_new_password(auth.MIN_PASSWORD)
    if not pw:
        return 1
    auth.unlock(auth.create_auth(username, pw))
    print("")
    print("  password set for %s" % username)
    moved = auth.encrypt_vault_rows()
    if moved:
        print("  %d stored secret%s encrypted" % (moved, "" if moved == 1 else "s"))
    print("")
    return 0


def run_change_password(auth):
    """--change-password: verify the current one, then re-seal the vault key."""
    if not auth.configured():
        print("")
        print("  no password is set yet, run: python3 atlas.py --setup")
        print("")
        return 1
    current = _ask_secret("  current password: ")
    if not current:
        return 1
    try:
        auth.verify_login(auth.username_of(), current)
    except auth.AuthError as e:
        print("      %s" % e)
        return 1
    print("")
    new = _ask_new_password(auth.MIN_PASSWORD)
    if not new:
        return 1
    auth.unlock(auth.change_password(current, new))
    moved = auth.encrypt_vault_rows()
    print("")
    print("  password changed; the vault key was re-sealed and every stored")
    print("  secret is still readable")
    if moved:
        print("  %d plain-text secret%s encrypted along the way"
              % (moved, "" if moved == 1 else "s"))
    print("")
    return 0


def first_run(auth):
    """Offer the setup on a first start at a terminal. Returns a startup warning."""
    warn = _WARN if _use_color() else ""
    reset = _RESET if _use_color() else ""
    print("")
    print("  %s[i] atlas has no password yet%s" % (warn, reset))
    print("      Set one to enable the login and encrypt the vault, or press Enter")
    print("      on the password to skip and run open for now.")
    print("")
    username = _ask_line("  username [admin]: ", "admin")
    pw = _ask_new_password(auth.MIN_PASSWORD, allow_skip=True)
    if not pw:
        return "skipped"
    auth.create_auth(username, pw)
    print("")
    print("  password set for %s" % username)
    return None


def main():
    from atlas import auth, config, crypto, db, server

    ap = argparse.ArgumentParser(description="atlas - an audit board for pentests")
    ap.add_argument("--host", default=None)
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--data", default=os.path.join(BASE, "data"))
    ap.add_argument("--conf", default=BASE, help="folder holding conf.json")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--no-banner", action="store_true", help="start without the logo")
    ap.add_argument("--no-tls", action="store_true", help="serve plain HTTP (not recommended)")
    ap.add_argument("--setup", action="store_true",
                    help="set the username and password from the terminal, then exit")
    ap.add_argument("--change-password", action="store_true",
                    help="change the password (re-seals the vault key, no re-encryption)")
    args = ap.parse_args()

    try:
        cfg, cfg_warnings = config.load(args.conf)
    except config.ConfigError as e:
        print("\n  %s[!] %s%s\n" % (_WARN if _use_color(sys.stderr) else "", e,
                                    _RESET if _use_color(sys.stderr) else ""), file=sys.stderr)
        return 4

    if not args.no_banner:
        print("")
        print(banner())
    print("")

    host = args.host if args.host is not None else cfg["host"]
    port = args.port if args.port is not None else cfg["port"]
    if args.no_tls:
        cfg["tls"] = False

    data_dir = os.path.abspath(args.data)
    db_path = os.path.join(data_dir, "atlas.db")

    try:
        db.configure(db_path)
        db.init()
    except db.DatabaseCorrupt as e:
        print("\n" + db_corrupt_help(e.path, e.cause), file=sys.stderr)
        return 2
    except db.DatabaseUnusable as e:
        print("\n" + db_io_help(e.path, e.cause), file=sys.stderr)
        return 3

    moved_files, missing_files, orphan_files = db.migrate_capture_files()

    if args.setup:
        return run_setup(auth)
    if args.change_password:
        return run_change_password(auth)

    legacy_note = auth.seed_from_config(cfg)
    open_note = None
    if not auth.configured():
        if sys.stdin.isatty() and sys.stdout.isatty():
            open_note = first_run(auth)
        else:
            open_note = "headless"

    tls_fallback = None
    try:
        try:
            httpd, scheme = server.serve(host, port, cfg, data_dir)
        except auth.TLSUnavailable:
            if cfg.get("_tls_explicit"):
                raise
            tls_fallback = True
            cfg["tls"] = False
            httpd, scheme = server.serve(host, port, cfg, data_dir)
    except db.DatabaseCorrupt as e:
        print("\n" + db_corrupt_help(e.path, e.cause), file=sys.stderr)
        return 2
    except db.DatabaseUnusable as e:
        print("\n" + db_io_help(e.path, e.cause), file=sys.stderr)
        return 3
    except auth.TLSUnavailable as e:
        print("\n" + tls_help(e), file=sys.stderr)
        return 5
    except OSError as e:
        warn = _WARN if _use_color(sys.stderr) else ""
        reset = _RESET if _use_color(sys.stderr) else ""
        print("\n  %s[!] cannot start: port %d on %s is already in use%s" % (warn, port, host, reset),
              file=sys.stderr)
        print("      Another atlas is probably already running. Open it in your browser,", file=sys.stderr)
        print("      or stop it first, or start this one on a different port:", file=sys.stderr)
        print("        python3 atlas.py --port 8778\n", file=sys.stderr)
        return 6
    url = "%s://%s:%d" % (scheme, "127.0.0.1" if host == "0.0.0.0" else host, port)
    warn = _WARN if _use_color() else ""
    reset = _RESET if _use_color() else ""
    dim = _DIM if _use_color() else ""

    print("  data      -> %s" % data_dir)
    print("  projects  -> %s" % os.path.join(data_dir, "projects"))
    print("  listening -> %s" % url)

    auth_on = auth.configured()
    print("  auth      -> %s" % ("login required (user: %s)" % auth.username_of() if auth_on
                                 else "%sDISABLED - no password set%s" % (warn, reset)))
    print("  vault     -> %s" % ("secrets encrypted, ChaCha20-Poly1305 (%s)" % crypto.backend_name()
                                 if auth_on
                                 else "%ssecrets stored in plain text%s" % (warn, reset)))
    print("  transport -> %s" % ("TLS (self-signed: your browser will warn once)" if scheme == "https"
                                 else "%splain HTTP, traffic is readable on the wire%s" % (warn, reset)))
    if tls_fallback:
        print("      %sno certificate could be generated, so TLS was skipped%s" % (dim, reset))
        print("      %sinstall `cryptography` or `openssl` to get HTTPS automatically%s" % (dim, reset))
    if auth_on:
        pending = auth.plaintext_rows()
        if pending:
            print("  %s[!] %d secret%s from an earlier version are still unencrypted%s"
                  % (warn, pending, "" if pending == 1 else "s", reset))
            print("      %sthey are encrypted automatically the next time you sign in%s"
                  % (dim, reset))
    if legacy_note:
        print("  %s[!] %s%s" % (warn, legacy_note, reset))
    if open_note == "headless":
        print("  %s[!] no password and no terminal to ask on: atlas is running open%s"
              % (warn, reset))
        print("      %sset one with: python3 atlas.py --setup%s" % (dim, reset))
    elif open_note == "skipped":
        print("  %s[!] running without a password: full access and unencrypted secrets%s"
              % (warn, reset))
        print("      %sset one with: python3 atlas.py --setup%s" % (dim, reset))
    if moved_files:
        print("  %s[i] %d capture%s moved into their project folder%s"
              % (dim, moved_files, "" if moved_files == 1 else "s", reset))
    if missing_files:
        print("  %s[!] %d capture%s recorded in the database but not found on disk%s"
              % (warn, missing_files, "" if missing_files == 1 else "s", reset))
    if orphan_files:
        print("  %s[!] %d file%s left in data/captures/ that no capture refers to%s"
              % (warn, len(orphan_files), "" if len(orphan_files) == 1 else "s", reset))
        print("      %snothing was deleted; move or remove them by hand%s" % (dim, reset))
    for w in cfg_warnings:
        print("  %s[!] %s%s" % (warn, w, reset))
    if host == "0.0.0.0" and not auth_on:
        print("  %s[!] exposed on every interface with no authentication%s" % (warn, reset))
    print("\n  Ctrl+C to stop\n")
    sys.stdout.flush()

    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopping...")
        httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main() or 0)
