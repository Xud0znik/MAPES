# MAPES

![MAPES](docs/banner.png)

A local board app: store nodes (notes, hosts, credentials, links, files - anything),
connect them, and organize them across separate boards (projects). Runs fully locally,
no internet needed - data is stored in SQLite right on your disk.

The idea is similar to [atlas-audit](https://github.com/Zoyma/atlas-audit), but not
tied to pentesting: it's a general-purpose visual board for anything.

## Getting started

### Option 1 - prebuilt binary, nothing to install (no admin/root needed)

Go to [Releases](../../releases) (or the latest [Actions run](../../actions)) in this
repository and download the build for your OS:

- **Windows**: `MAPES.exe` - just double-click it. Opens its own app window (no
  browser, no address bar).
- **Linux**: `MAPES-linux` - download it, `chmod +x MAPES-linux`, then run
  `./MAPES-linux`. No root/sudo needed - it's a single self-contained binary. If your
  desktop has GTK/WebKit (most GNOME/desktop Ubuntu installs do), it opens its own
  window; otherwise it automatically opens in your default browser instead - either
  way it just works, nothing to install.

Data is saved in a `data` folder next to the binary.

### Option 2 - from source (Windows/macOS/Linux)

Requires Python 3.9+.

```bash
git clone https://github.com/xud0znik/mapes.git
cd mapes
pip install -r requirements.txt
python mapes.py
```

The app starts a local server on `http://127.0.0.1:5057` and opens its own window
(via pywebview). If pywebview fails to load (e.g. on Linux without the required
system libraries - GTK/Qt), the app automatically falls back to a regular browser
tab. Nothing is ever sent over the internet - the server only listens on `127.0.0.1`.

### Building the binary yourself

```bash
pip install -r requirements.txt pyinstaller
pyinstaller packaging/mapes.spec
```

The built file appears at `dist/MAPES` (`dist/MAPES.exe` on Windows) for whatever OS
you ran PyInstaller on - it doesn't cross-compile. There's also a GitHub Actions
workflow (`.github/workflows/build-exe.yml`) that builds both the Windows and Linux
binaries on every manual run, and attaches them to a GitHub Release when one is
published.

## Where data is stored

MAPES doesn't ask anything on startup - as always, it quietly uses the `data` folder
next to the app (that's where `mapes.db`, a SQLite file, lives). You can open a
different database or save a copy of the board somewhere else at any time, right in
the UI, in the sidebar's **"File"** section:

- **Open** - switch the app to an existing (or new) `.db` file/folder. All boards,
  nodes, and connections in it are loaded right away.
- **Save As...** - pick a destination file and save a copy of the current board there
  (safely, via SQLite's built-in backup API, no risk of corrupting the file). The path
  is remembered.
- **Save** - becomes active after the first "Save As"; re-saves the board to that same
  remembered file with one click, no need to pick the path again.

In the built `.exe`, "Open"/"Save As" open a native file picker (via the
`window.pywebview.api` bridge). In browser mode (when pywebview isn't available), a
text prompt for the path appears instead.

You can also set the working folder directly via the `MAPES_DATA_DIR` environment
variable - handy for scripted startup or for keeping data in a synced folder (Google
Drive, Dropbox, etc). It accepts either a folder or a direct path to a `.db` file:

```bash
MAPES_DATA_DIR="/path/to/folder-or-file.db" python mapes.py
```

The `data` folder isn't committed to git (see `.gitignore`). For a backup, just copy
the `mapes.db` file, or use "Save As" right in the app.

### Using MAPES on more than one device

MAPES has no server/account/login by design, so there's no built-in cloud sync - but
you don't need one to move between devices. Point `MAPES_DATA_DIR` (or "Open" in the
UI) at a folder inside Dropbox/Google Drive/OneDrive, and that cloud client keeps the
`mapes.db` file (plus the `captures/` folder) in sync for you automatically. Works
just as well by copying the `data` folder onto a USB drive if you'd rather not use a
cloud folder. Either way: only have the app open on **one device at a time** - SQLite
files don't handle two processes writing to them concurrently over a network share.

## Features

**Board** (as before):
- Multiple boards, each its own independent space of nodes
- Different node types: note, host/server, account/password, link, file/path, other
- Freely drag nodes around the canvas, zoom (Ctrl/Alt + scroll), position is saved
- Connections between nodes ("Connect nodes" button → click two nodes)
- Tags and node color, right-click to duplicate/delete
- Search by title/content/tags within a board
- Export/import a board as JSON

Plus four sections on top of the board (functionally in the spirit of
[atlas-audit](https://github.com/Zoyma/atlas-audit), adapted to MAPES's general-purpose,
not just pentest-specific, model):

- **🖼 Vault** - file/screenshot storage. Upload a file, optionally link it to a node,
  caption it, tag it. Files live on disk next to the database
  (`data/captures/<board-id>/`) - not copied along with the database via "Save As",
  which only copies the .db.
- **🔑 Credentials** - accounts/passwords/hashes/keys linked to nodes. The secret is
  encrypted at rest (ChaCha20-Poly1305, with the key in a separate `secret.key` file
  next to the app, not in git). This protects against the database file itself
  leaking accidentally, not a full master-password vault - MAPES has no login by
  design (see "What's next" below).
- **⚑ Findings** - a list of findings/issues with severity (crit/high/med/low/info)
  and status (open/fixed/accepted risk), linked to a node, with
  description/impact/PoC/remediation/references.
- **▤ Reports** - markdown notes/reports with a live preview (a small built-in
  renderer: headings, lists, quotes, code, **bold**/*italic*, links) and export to
  `.md`.

## Project structure

```
mapes.py               entry point: starts the server and opens the window (pywebview) / browser
mapes/
  app.py                Flask app and REST API
  db.py                 SQLite: schema and connection
  crypto.py             secret encryption for Credentials (ChaCha20-Poly1305)
  paths.py              paths to data and bundled resources (works from a frozen .exe too)
  templates/index.html  page markup
  static/css/style.css  styles
  static/js/app.js      canvas, tabs, modals, markdown preview logic
packaging/mapes.spec    PyInstaller config for building the .exe
.github/workflows/      auto-builds MAPES.exe on GitHub Actions
data/                   created at runtime: mapes.db + captures/ (not in git)
```

## What's next

Deliberately not ported from Atlas (can be added on request):
- login/password and sessions - conflicts with the "never ask anything on startup" idea
- separate Host/Service types (in MAPES these are just nodes with type "host")
- credential×node matrix, CVSS calculator, PDF report export, markdown-editor snippets

Keeps evolving on request.
