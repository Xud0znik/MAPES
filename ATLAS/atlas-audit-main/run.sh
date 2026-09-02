#!/usr/bin/env bash
# Quick launcher for atlas on Kali / Linux.
#   ./run.sh            -> http://127.0.0.1:8777
#   ./run.sh --port 9000
cd "$(dirname "$0")" || exit 1
exec python3 atlas.py "$@"
