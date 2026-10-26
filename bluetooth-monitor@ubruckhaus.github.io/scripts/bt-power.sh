#!/bin/bash
# Turn Bluetooth on or off through the rfkill soft block, like GNOME's own Bluetooth
# switch (gnome-settings-daemon follows the block, and it survives a reboot).
# Usage: bt-power.sh on|off
set -u
powered() {
  local c
  for c in $(timeout 2s bluetoothctl list 2>/dev/null | awk '{print $2}'); do
    [[ $(timeout 2s bluetoothctl show "$c" 2>/dev/null) == *"Powered: yes"* ]] && return 0
  done
  return 1
}
wait_powered() {
  local deadline=$((SECONDS + 2))
  while :; do
    powered && return 0
    ((SECONDS < deadline)) || return 1
    sleep 0.2
  done
}
case "${1:-}" in
  on)
    rfkill unblock bluetooth
    wait_powered && exit 0
    timeout 5s bluetoothctl power on >/dev/null 2>&1
    wait_powered
    ;;
  off)
    rfkill block bluetooth
    ;;
  *)
    echo "usage: $0 on|off" >&2
    exit 2
    ;;
esac
