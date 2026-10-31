#!/bin/sh
# ATexVisualEditor launcher for Linux and macOS.
cd "$(dirname "$0")" || exit 1
exec python3 atex.py --open "$@"
