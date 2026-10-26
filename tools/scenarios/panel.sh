# Processes of this test shell only: their paths are inside the test's data folder or tools/.
collectors() { pgrep -fc "$EXT/scripts/bluetooth-monitor.py"; }
scans() { pgrep -fc "mock-bin/bluetoothctl --timeout"; }
check() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; FAILED=1; fi; }
sleep 22
echo "--- mock log"; sort "$MOCK_LOG" | uniq -c | sed 's/^/  /'
check "collector told open/closed" 'grep -q "collector .*\"cmd\": *\"open\"" "$MOCK_LOG" && grep -q "collector .*\"cmd\": *\"closed\"" "$MOCK_LOG"'
check "a toggle sent a set command" 'grep -q "\"cmd\": *\"set\".*\"key\": *\"invert\"" "$MOCK_LOG"'
check "a wheel pill sent a set command" 'grep -q "\"key\": *\"smartshift\"" "$MOCK_LOG"'
check "a slider change survived a rebuild" 'grep -q "\"key\":\"dpi\",\"value\":4100" "$MOCK_LOG"'
check "scan ran through bluetoothctl" 'grep -q "bluetoothctl --timeout 300 scan on" "$MOCK_LOG"'
check "connect went through bluetoothctl" 'grep -q "bluetoothctl connect AA:BB:CC:DD:EE:02" "$MOCK_LOG"'
check "pair went through bluetoothctl" 'grep -q "bluetoothctl pair AA:BB:CC:DD:EE:03" "$MOCK_LOG"'
check "forget removed the device" 'grep -q "bluetoothctl remove AA:BB:CC:DD:EE:01" "$MOCK_LOG"'
check "power off used rfkill" 'grep -q "rfkill block bluetooth" "$MOCK_LOG"'
check "a non-address never reached a helper" '! grep -q -- "--help" "$MOCK_LOG"'
check "scan stopped when the menu closed" '[ "$(scans)" = 0 ]'
echo "--- disable / enable (like locking and unlocking)"
gnome-extensions disable $UUID; sleep 1
check "collector stopped with the extension" '[ "$(collectors)" = 0 ]'
gnome-extensions enable $UUID; sleep 3
gnome-extensions info $UUID | grep State
check "one collector running" '[ "$(collectors)" = 1 ]'
