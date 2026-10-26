#!/usr/bin/env python3
"""Stand-in for scripts/bluetooth-monitor.py in the headless test: streams one fixed
snapshot (two Bolt dongles, a Bluetooth trackpad and earphones, one keyboard low on
battery) and logs every command it gets on stdin to $MOCK_LOG."""
import json
import os
import select
import sys

SNAP = {
    "phase": "ok", "denied": [],
    "receivers": [
        {"id": "r-hidraw2", "family": "bolt", "name": "Bolt receiver", "node": "hidraw2", "max_devices": 6, "connected": 1, "devices": ["hidraw2-1"]},
        {"id": "r-hidraw6", "family": "bolt", "name": "Bolt receiver", "node": "hidraw6", "max_devices": 6, "connected": 1, "devices": ["hidraw6-1"]},
    ],
    "adapters": [{"id": "hci0", "builtin": True, "bus": "usb", "vendor": "MediaTek"}],
    "devices": [
        {"id": "hidraw2-1", "key": "wpid:b034", "kind": "mouse", "name": "MX Master 3S", "online": True,
         "receiver": "r-hidraw2", "slot": 1, "connection": "bolt",
         "battery": {"percent": 70, "level": "good", "charging": False, "status": "discharging"},
         "dpi": {"value": 1000, "min": 200, "max": 8000, "step": 50, "default": 1000},
         "smartshift": {"mode": "smartshift", "threshold": 12, "enhanced": True},
         "wheel": {"invert": False, "hires": True}},
        {"id": "hidraw6-1", "key": "wpid:b35b", "kind": "keyboard", "name": "MX Keys S", "online": True,
         "receiver": "r-hidraw6", "slot": 1, "connection": "bolt",
         "battery": {"percent": 18, "level": "low", "charging": False, "status": "discharging"},
         "fnswap": {"on": True}},
        {"id": "bt-AABBCCDDEE01", "key": "bt:AA:BB:CC:DD:EE:01", "kind": "touchpad", "name": "Magic Trackpad", "online": True,
         "receiver": None, "slot": None, "connection": "bluetooth", "adapter": "hci0",
         "battery": {"percent": 55, "level": "good", "charging": True, "status": "charging"}},
        {"id": "bt-AABBCCDDEE02", "key": "bt:AA:BB:CC:DD:EE:02", "kind": "headset", "name": "WH-1000XM5", "online": False,
         "receiver": None, "slot": None, "connection": "bluetooth", "adapter": "hci0", "battery": None},
    ],
    "lowest": 18, "updated": 0, "message_code": "", "message_args": [],
}
log = os.environ.get("MOCK_LOG", "/dev/null")
pending = b""
while True:
    print(json.dumps(SNAP), flush=True)
    ready, _, _ = select.select([sys.stdin], [], [], 1.0)
    if ready:
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            break
        pending += chunk
        *lines, pending = pending.split(b"\n")
        with open(log, "a") as f:
            for line in lines:
                f.write("collector " + line.decode() + "\n")
