#!/bin/bash
# Runs the extension in a throwaway headless GNOME Shell with its own D-Bus, dconf and
# data folders, and prints the extension's log. Every command that could change a real
# device (bluetoothctl, rfkill, pactl, pkexec) is a logging stand-in from tools/mock-bin,
# and the scenarios replace the collector with a fake one and BlueZ with fake devices:
# a test never pairs, connects, powers off or writes a setting to a real device.
# Usage: [MONITOR=WxH] tools/headless-test.sh [scenario]   (scenarios in tools/scenarios/)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=bluetooth-monitor@ubruckhaus.github.io
if [ -z "${BT_INNER:-}" ]; then
    T=$(mktemp -d)
    mkdir -p "$T/config" "$T/data" "$T/cache" "$T/state"
    export BT_INNER=1 T XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_CACHE_HOME=$T/cache XDG_STATE_HOME=$T/state
    dbus-run-session -- "$0" "$@" 2> >(grep -v -e dbus-daemon -e fusermount >&2)
    status=$?
    rm -rf "$T"
    exit $status
fi
export PATH="$ROOT/tools/mock-bin:$PATH" MOCK_LOG="$T/mock.log"
: > "$MOCK_LOG"
EXT=$XDG_DATA_HOME/gnome-shell/extensions/$UUID
"$ROOT/tools/build.sh" >/dev/null && mkdir -p "$EXT" && unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXT" \
    || { echo "build failed" >&2; exit 1; }
glib-compile-schemas "$EXT/schemas"
S="gsettings --schemadir $EXT/schemas"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "$(gnome-shell --version | awk '{print $3}')"
[ "$(gsettings get org.gnome.shell enabled-extensions)" = "['$UUID']" ] || { echo "isolated dconf not working" >&2; exit 1; }
SCENARIO=${1:-panel}
[ -f "$ROOT/tools/scenarios/$SCENARIO.pre.sh" ] && . "$ROOT/tools/scenarios/$SCENARIO.pre.sh"

gnome-shell --headless --wayland --no-x11 --virtual-monitor ${MONITOR:-1920x1080} \
    --wayland-display bt-test >"$T/shell.log" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID 2>/dev/null' EXIT
FAILED=0
sleep 8
export WAYLAND_DISPLAY=bt-test
# No X fallback: an app that loses the test shell must not open in the real session.
unset DISPLAY
. "$ROOT/tools/scenarios/$SCENARIO.sh"
kill $SHELL_PID 2>/dev/null; sleep 1
[ -n "${KEEP_LOG:-}" ] && cp "$T/shell.log" "$KEEP_LOG"
grep -v -e Gtk-WARNING -e "^$" "$T/shell.log" | grep -i -e "bluetooth monitor\|js\|error\|exception" | head -${LINES_MAX:-80}
grep -e "JS ERROR" -e "St-CRITICAL" "$T/shell.log" | grep -qv "gnome-shell-disable-extensions" && { echo "FAIL: errors in the shell log"; FAILED=1; }
exit $FAILED
