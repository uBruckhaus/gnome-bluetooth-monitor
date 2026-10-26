# Test-only patch of the copied extension: the fake collector, fake BlueZ devices, then
# screenshots of the bar and every page, and each action once (all against tools/mock-bin).
cat >> "$EXT/extension.js" <<'JS'
import Shell from 'gi://Shell';
const FAKE_BT = [
    {address: 'AA:BB:CC:DD:EE:01', name: 'Magic Trackpad', icon: 'input-tablet', connected: true, known: true, battery: 55},
    {address: 'AA:BB:CC:DD:EE:02', name: 'WH-1000XM5', icon: 'audio-headphones', connected: false, known: true, battery: -1},
    {address: 'AA:BB:CC:DD:EE:03', name: 'JBL Flip 6', icon: 'audio-card', connected: false, known: false, battery: -1},
    {address: 'AA:BB:CC:DD:EE:04', name: 'AA-BB-CC-DD-EE-04', icon: '', connected: false, known: false, battery: -1},
];
BluetoothModel.prototype.devices = function () { return FAKE_BT.map(d => ({...d})); };
Object.defineProperty(BluetoothModel.prototype, 'hasAdapter', {get() { return true; }});
Object.defineProperty(BluetoothModel.prototype, 'powered', {get() { return true; }});
const _origEnable = BluetoothMonitorExtension.prototype.enable;
BluetoothMonitorExtension.prototype.enable = function () {
    _origEnable.call(this);
    if (globalThis._btTestStarted)
        return;
    globalThis._btTestStarted = true;
    const ind = this._indicator;
    const shot = name => new Promise(resolve => {
        const file = Gio.File.new_for_path(`${GLib.getenv('BT_SHOT_DIR')}/${name}.png`);
        const stream = file.replace(null, false, 0, null);
        new Shell.Screenshot().screenshot(false, stream, (s, r) => {
            s.screenshot_finish(r); stream.close(null);
            console.log(`[Bluetooth Monitor] screenshot ${name} written`);
            resolve();
        });
    });
    const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
    const find = (actor, cls, unchecked = false) => {
        if (actor.has_style_class_name?.(cls) && !(unchecked && actor.has_style_pseudo_class('checked')))
            return actor;
        for (const c of actor.get_children()) {
            const f = find(c, cls, unchecked);
            if (f)
                return f;
        }
        return null;
    };
    (async () => {
        await wait(9000);
        Main.overview.hide();
        await wait(3000);
        console.log(`[Bluetooth Monitor] bar icon ${ind._icon.icon_name}, style "${ind._icon.style}"`);
        await shot('bar');
        ind.menu.open(false);
        await wait(1500);
        await shot('main');
        ind._panel.expanded.add('hidraw2-1');
        ind._panel.expanded.add('hidraw6-1');
        ind._panel.rebuild();
        await wait(800);
        await shot('settings-cards');
        // A scroll on the DPI slider, then a rebuild before its send delay: the change must still go out.
        const slider = find(ind._panel.actor, 'btmon-slider');
        slider.value = 0.5;
        ind._panel.rebuild();
        await wait(300);
        // Each write once, through the real widgets: a toggle, a wheel-mode pill.
        find(ind._panel.actor, 'btmon-toggle')?.emit('clicked', 1);
        const pill = find(ind._panel.actor, 'btmon-choice', true);
        console.log(`[Bluetooth Monitor] pill ${pill?.label} checked ${pill?.has_style_pseudo_class('checked')}`);
        pill?.emit('clicked', 1);
        await wait(500);
        ind._panel.setPage('settings');
        await wait(800);
        await shot('settings-page');
        ind._panel.setPage('bt');
        await wait(1500);
        console.log(`[Bluetooth Monitor] scanning ${ind.scanning}`);
        await shot('bluetooth');
        ind.btAction('connect', 'AA:BB:CC:DD:EE:02', 'connecting');
        ind.btAction('pair', 'AA:BB:CC:DD:EE:03', 'connecting');
        ind.btAction('connect', '--help', 'connecting');
        ind._panel.confirmForget = 'AA:BB:CC:DD:EE:01';
        ind._panel.rebuild();
        await wait(800);
        await shot('bluetooth-actions');
        ind.btAction('forget', 'AA:BB:CC:DD:EE:01', 'forgetting');
        ind.btPower(false);
        await wait(1500);
        ind.menu.close(false);
        await wait(1000);
        console.log(`[Bluetooth Monitor] after close: scanning ${ind.scanning}, scanProc ${!!ind._scanProc}`);
    })().catch(e => console.error(`[Bluetooth Monitor] test: ${e}`));
};
JS
export BT_SHOT_DIR="${BT_SHOT_DIR:-$ROOT/dist/screenshots}"; mkdir -p "$BT_SHOT_DIR"
