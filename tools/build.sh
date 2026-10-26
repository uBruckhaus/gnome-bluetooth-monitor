#!/bin/sh
# Builds dist/bluetooth-monitor@ubruckhaus.github.io.shell-extension.zip (schema included).
set -eu
cd "$(dirname "$0")/.."
UUID=bluetooth-monitor@ubruckhaus.github.io
mkdir -p dist
find "$UUID" -name __pycache__ -prune -exec rm -rf {} +
gnome-extensions pack "$UUID" --force --out-dir dist \
    --schema=schemas/org.gnome.shell.extensions.bluetooth-monitor.gschema.xml \
    --extra-source=scripts --extra-source=../LICENSE
echo "dist/$UUID.shell-extension.zip"
