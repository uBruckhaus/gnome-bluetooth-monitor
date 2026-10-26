// Bluetooth Monitor for GNOME: batteries and connections of wireless mice, keyboards,
// trackpads, earphones and controllers in the top bar. The icon is green while every
// connected battery is fine, orange when one runs low and red when one is critical,
// and it turns into the device that needs charging (mouse on a tie). Left click opens
// the panel: a connection map (this PC, dongles and Bluetooth adapters, the devices on
// them), one card per device with Logitech settings, and a Bluetooth page that scans,
// pairs, connects, disconnects and forgets devices. Right click refreshes.
//
// Device data comes from scripts/bluetooth-monitor.py (HID++ over /dev/hidraw, UPower,
// BlueZ), which takes JSON commands on stdin and streams JSON snapshots on stdout. The
// Bluetooth page reads BlueZ through GnomeBluetooth, like GNOME's own quick settings;
// every action that changes something runs one of the scripts/ helpers with a fixed argv.

import 'gi://GnomeBluetooth?version=3.0';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeBluetooth from 'gi://GnomeBluetooth';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const RESTART_DELAY = 5;          // seconds before a collector that exited starts again
const PENDING_TIMEOUT = 20;       // seconds a Bluetooth action may show "Connecting…"
const SCAN_SECONDS = 300;         // bluetoothctl's own scan timeout (a backstop)
const SEND_DELAY = 500;           // ms a slider waits after the last change before writing
const DIM = 150;                  // opacity of secondary text
const MAX_AVAILABLE = 40;         // devices found by a scan that are listed

// Battery states in the GNOME palette (the Omarchy widget used the theme's colours).
const COLORS = {ok: '#33d17a', low: '#ff7800', critical: '#e01b24'};

const ADDRESS_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const MAC_NAME_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const UUID_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONNECTIONS = {
    unifying: 'Unifying dongle', bolt: 'Bolt dongle', nano: 'Nano dongle', lightspeed: 'Lightspeed dongle',
    bluetooth: 'Bluetooth', usb: 'USB cable', wireless: 'Wireless',
};
const MESSAGES = {
    errNotConnected: () => 'That device is not connected right now.',
    errChange: why => `Could not change the setting (${why}).`,
};

function kindIcon(kind) {
    switch (kind) {
    case 'mouse': case 'trackball': return 'input-mouse-symbolic';
    case 'keyboard': return 'input-keyboard-symbolic';
    case 'numpad': case 'remote': return 'input-dialpad-symbolic';
    case 'touchpad': return 'input-touchpad-symbolic';
    case 'headset': return 'audio-headphones-symbolic';
    case 'speaker': return 'audio-speakers-symbolic';
    case 'presenter': return 'video-display-symbolic';
    case 'gamepad': case 'joystick': return 'input-gaming-symbolic';
    case 'tablet': case 'pen': return 'input-tablet-symbolic';
    case 'phone': return 'phone-symbolic';
    case 'camera': return 'camera-web-symbolic';
    default: return 'bluetooth-active-symbolic';
    }
}

// BlueZ's device icon names (input-mouse, audio-headset, ...) to a symbolic icon.
function bluezIcon(icon, connected) {
    const s = String(icon ?? '');
    if (s.startsWith('audio-head')) return 'audio-headphones-symbolic';
    if (s.startsWith('audio')) return 'audio-speakers-symbolic';
    if (s.startsWith('input-mouse')) return 'input-mouse-symbolic';
    if (s.startsWith('input-keyboard')) return 'input-keyboard-symbolic';
    if (s.startsWith('input-gaming')) return 'input-gaming-symbolic';
    if (s.startsWith('input-tablet')) return 'input-touchpad-symbolic';   // BlueZ calls trackpads tablets
    if (s.startsWith('video')) return 'video-display-symbolic';
    if (s.startsWith('phone')) return 'phone-symbolic';
    if (s.startsWith('computer')) return 'computer-symbolic';
    return connected ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic';
}

function batteryIcon(b) {
    if (!b)
        return 'battery-missing-symbolic';
    const p = b.percent;
    if (p === null || p === undefined) {
        const low = b.level === 'critical' || b.level === 'low' || b.level === 'empty';
        return `battery-level-${low ? 10 : 80}${b.charging ? '-charging' : ''}-symbolic`;
    }
    const step = Math.max(0, Math.min(100, Math.round(p / 10) * 10));
    return `battery-level-${step}${b.charging ? '-charging' : ''}-symbolic`;
}

function batteryText(b) {
    if (!b)
        return '';
    return b.percent !== null && b.percent !== undefined ? `${b.percent}%` : String(b.level ?? '');
}

function deviceName(d) {
    return d.name || 'Logitech device';
}

function deviceKey(d) {
    return String(d.key || d.id || '');
}

function hasSettings(d) {
    return !!(d.dpi || d.smartshift || d.wheel || d.fnswap);
}

// ---------------------------------------------------------------------------------- collector

// scripts/bluetooth-monitor.py: JSON snapshots on stdout, JSON commands on stdin.
class Collector {
    constructor(script, onSnapshot, onStart) {
        this._script = script;
        this._onSnapshot = onSnapshot;
        this._onStart = onStart;
        this._stopped = false;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        const python = GLib.find_program_in_path('python3');
        try {
            if (!python)
                throw new Error('python3 not found');
            this._proc = Gio.Subprocess.new([python, '-I', this._script],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`[Bluetooth Monitor] collector did not start: ${e.message}`);
            this._restartLater();
            return;
        }
        this._stdin = this._proc.get_stdin_pipe();
        this._queue = [];
        const stream = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe(), close_base_stream: true});
        this._readLine(stream, this._cancellable);
        this._proc.wait_async(this._cancellable, (proc, result) => {
            try {
                proc.wait_finish(result);
            } catch {
                return;     // cancelled: stop() was called
            }
            this._proc = null;
            this._stdin = null;
            this._restartLater();
        });
        this._onStart?.();
    }

    // One command per line, written asynchronously so a stalled collector cannot block
    // the shell. A stream takes one write at a time: commands sent together wait in a
    // queue (a second write_bytes_async while one is pending would fail).
    send(obj) {
        if (!this._stdin)
            return;
        this._queue.push(`${JSON.stringify(obj)}\n`);
        if (this._queue.length === 1)
            this._writeNext(this._stdin, this._cancellable);
    }

    _writeNext(stdin, cancellable) {
        if (!this._queue.length || stdin !== this._stdin)
            return;
        const bytes = new GLib.Bytes(new TextEncoder().encode(this._queue[0]));
        stdin.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancellable, (s, r) => {
            try {
                s.write_bytes_finish(r);
            } catch {
                // the collector exited or stop() cancelled: it is told the state again on restart
                this._queue = [];
                return;
            }
            this._queue.shift();
            this._writeNext(stdin, cancellable);
        });
    }

    _readLine(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, result) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(result);
            } catch {
                return;     // cancelled or the pipe closed
            }
            if (line === null)
                return;
            try {
                const data = JSON.parse(line);
                if (data && typeof data === 'object')
                    this._onSnapshot(data);
            } catch {
                // a partial line while the collector exits
            }
            this._readLine(s, cancellable);
        });
    }

    _restartLater() {
        if (this._stopped || this._restartId)
            return;
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESTART_DELAY, () => {
            this._restartId = 0;
            if (!this._stopped)
                this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        this._stopped = true;
        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = 0;
        this._cancellable?.cancel();
        this._proc?.force_exit();
        this._proc = null;
        this._stdin = null;
    }
}

// ---------------------------------------------------------------------------------- Bluetooth

// BlueZ through GnomeBluetooth: the adapter's power and the devices it knows. Rows hold
// plain values only, never the device objects (they can vanish mid-update).
class BluetoothModel {
    constructor(onChange) {
        this._onChange = onChange;
        this._client = new GnomeBluetooth.Client();
        this._clientIds = [
            this._client.connect('notify::default-adapter', () => this._changed()),
            this._client.connect('notify::default-adapter-powered', () => this._changed()),
            this._client.connect('notify::default-adapter-state', () => this._changed()),
            this._client.connect('device-added', (_c, device) => {
                this._watch(device);
                this._changed();
            }),
            this._client.connect('device-removed', () => this._changed()),
        ];
        this._deviceIds = new Map();
        const store = this._client.get_devices();
        for (let i = 0; i < store.get_n_items(); i++)
            this._watch(store.get_item(i));
    }

    _watch(device) {
        if (!this._deviceIds.has(device))
            this._deviceIds.set(device, device.connect('notify', () => this._changed()));
    }

    // Many property changes arrive together: tell the panel once.
    _changed() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._onChange();
            return GLib.SOURCE_REMOVE;
        });
    }

    get hasAdapter() {
        return !!this._client.default_adapter;
    }

    get powered() {
        return this.hasAdapter && this._client.default_adapter_powered;
    }

    devices() {
        const out = [];
        const store = this._client.get_devices();
        for (let i = 0; i < store.get_n_items(); i++) {
            const d = store.get_item(i);
            const name = String(d.alias || d.name || '').trim();
            const percent = d.battery_type !== undefined && d.battery_type !== GnomeBluetooth.BatteryType.NONE
                ? Math.round(d.battery_percentage) : -1;
            out.push({
                address: String(d.address || ''), name, icon: String(d.icon || ''),
                connected: !!d.connected, known: !!(d.paired || d.trusted || d.bonded),
                battery: percent,
            });
        }
        return out;
    }

    // Connected, paired (or trusted) and, while scanning, the other devices nearby.
    rows(scanning) {
        const sections = {connected: [], paired: [], available: []};
        for (const d of this.devices()) {
            if (!d.name || MAC_NAME_RE.test(d.name) || UUID_NAME_RE.test(d.name) || !ADDRESS_RE.test(d.address))
                continue;
            if (d.connected)
                sections.connected.push({...d, section: 'connected'});
            else if (d.known)
                sections.paired.push({...d, section: 'paired'});
            else if (scanning)
                sections.available.push({...d, section: 'available'});
        }
        const byName = (a, b) => a.name.localeCompare(b.name);
        sections.connected.sort(byName);
        sections.paired.sort(byName);
        sections.available = sections.available.sort(byName).slice(0, MAX_AVAILABLE);
        return sections;
    }

    find(address) {
        return this.devices().find(d => d.address === address) ?? null;
    }

    destroy() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        for (const id of this._clientIds)
            this._client.disconnect(id);
        for (const [device, id] of this._deviceIds)
            device.disconnect(id);
        this._deviceIds.clear();
        this._client = null;
    }
}

// ---------------------------------------------------------------------------------- widgets

function label(text = '', styleClass = '', props = {}) {
    const actor = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function dimmed(actor) {
    actor.opacity = DIM;
    return actor;
}

function wrapping(actor) {
    actor.clutter_text.line_wrap = true;
    actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

function hbox(props = {}) {
    return new St.BoxLayout({x_expand: true, ...props});
}

function vbox(props = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, ...props});
}

function icon(name, styleClass = 'btmon-icon') {
    return new St.Icon({icon_name: name, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

// A bordered button with an optional icon and text.
function button(text, iconName, onClick, props = {}) {
    const box = hbox({x_expand: false, style_class: 'btmon-button-box'});
    if (iconName)
        box.add_child(icon(iconName, 'btmon-button-icon'));
    if (text)
        box.add_child(label(text, 'btmon-button-label'));
    const b = new St.Button({style_class: 'btmon-button', child: box, can_focus: true, y_align: Clutter.ActorAlign.CENTER, ...props});
    b.connect('clicked', () => onClick());
    return b;
}

// An on/off switch drawn here: GNOME's PopupMenu.Switch only toggles by dragging its knob.
function toggle(on, onToggle) {
    const knob = new St.Widget({style_class: 'btmon-toggle-knob', x_align: on ? Clutter.ActorAlign.END : Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
    const track = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
    track.add_child(knob);
    const b = new St.Button({style_class: 'btmon-toggle', child: track, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
    if (on)
        b.add_style_pseudo_class('checked');
    b.connect('clicked', () => onToggle(!on));
    return b;
}

// Pills of which one is picked.
function choices(options, value, onPick) {
    const box = hbox({x_expand: false, style_class: 'btmon-choices'});
    for (const option of options) {
        const b = new St.Button({style_class: 'btmon-choice', label: option.label, can_focus: true});
        if (option.value === value)
            b.add_style_pseudo_class('checked');
        b.connect('clicked', () => {
            if (option.value !== value)
                onPick(option.value);
        });
        box.add_child(b);
    }
    return box;
}

// Caption and hint on the left, a control on the right (or below, for wide controls).
function settingRow(caption, hint, control, below = false) {
    const row = below ? vbox({style_class: 'btmon-setting btmon-setting-below'}) : hbox({style_class: 'btmon-setting'});
    const text = vbox();
    text.add_child(label(caption, 'btmon-caption'));
    if (hint)
        text.add_child(wrapping(dimmed(label(hint, 'btmon-hint'))));
    row.add_child(text);
    row.add_child(control);
    return row;
}

function sectionHeader(text) {
    return label(text.toUpperCase(), 'btmon-section');
}

function separator() {
    return new St.Widget({style_class: 'btmon-separator', x_expand: true});
}

// A slider for min..max in steps; `onSet` gets the value once the user lets go (or
// stops scrolling for a moment).
class StepSlider {
    constructor(min, max, step, value, format, onSet, owner) {
        this._min = min;
        this._max = Math.max(max, min + 1);
        this._step = step > 0 ? step : 1;
        this._sent = value;
        this._onSet = onSet;
        this._owner = owner;
        this.slider = new Slider((value - this._min) / (this._max - this._min));
        this.slider.add_style_class_name('btmon-slider');
        this.valueLabel = label(format(value), 'btmon-caption btmon-value');
        this._format = format;
        this.slider.connect('notify::value', () => {
            this.valueLabel.text = format(this.value);
            if (!this._dragging)
                this._sendLater();
        });
        this.slider.connect('drag-begin', () => {
            this._dragging = true;
            owner.holdUpdates(true);
        });
        this.slider.connect('drag-end', () => {
            this._dragging = false;
            owner.holdUpdates(false);
            this._send();
        });
        this.slider.connect('destroy', () => {
            if (this._timer)
                GLib.source_remove(this._timer);
            this._timer = 0;
            if (this._dragging)
                owner.holdUpdates(false);
        });
    }

    get value() {
        const raw = this._min + this.slider.value * (this._max - this._min);
        return Math.min(this._max, Math.max(this._min, this._min + Math.round((raw - this._min) / this._step) * this._step));
    }

    _sendLater() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEND_DELAY, () => {
            this._timer = 0;
            this._send();
            return GLib.SOURCE_REMOVE;
        });
    }

    _send() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        const v = this.value;
        if (v !== this._sent) {
            this._sent = v;
            this._onSet(v);
        }
    }
}

// ---------------------------------------------------------------------------------- panel

class DetailPanel {
    constructor(indicator) {
        this._ind = indicator;
        this.page = 'main';
        this.showHidden = false;
        this.expanded = new Set();
        this.confirmForget = '';
        this._held = 0;

        this.actor = vbox({style_class: 'btmon-panel'});
        this._hero = hbox({style_class: 'btmon-hero'});
        this._heroIcon = icon('input-mouse-symbolic', 'btmon-hero-icon');
        const heroText = vbox({y_align: Clutter.ActorAlign.CENTER});
        heroText.add_child(label('Bluetooth Monitor', 'btmon-title'));
        this._heroMeta = wrapping(dimmed(label('', 'btmon-caption')));
        heroText.add_child(this._heroMeta);
        this._pill = label('', 'btmon-pill', {y_align: Clutter.ActorAlign.CENTER});
        this._heroButtons = hbox({x_expand: false, style_class: 'btmon-hero-buttons', y_align: Clutter.ActorAlign.CENTER});
        this._hero.add_child(this._heroIcon);
        this._hero.add_child(heroText);
        this._hero.add_child(this._pill);
        this._hero.add_child(this._heroButtons);
        this.actor.add_child(this._hero);
        this._body = vbox({style_class: 'btmon-body'});
        this.actor.add_child(this._body);
    }

    // While a slider is dragged, snapshots do not rebuild the cards under it.
    holdUpdates(on) {
        this._held = Math.max(0, this._held + (on ? 1 : -1));
        if (!this._held && this._pending) {
            this._pending = false;
            this.rebuild();
        }
    }

    setPage(page) {
        this.page = page;
        this.confirmForget = '';
        this.rebuild();
        this._ind.syncScan();
    }

    reset() {
        this.page = 'main';
        this.showHidden = false;
        this.confirmForget = '';
    }

    rebuild() {
        if (this._held) {
            this._pending = true;
            return;
        }
        const ind = this._ind;
        const stats = ind.stats;
        const shown = ind.shownDevices();
        const online = shown.filter(d => d.online).length;
        const receivers = stats.receivers || [];
        const phase = String(stats.phase || 'starting');

        this._heroIcon.style_class = `btmon-hero-icon${online ? ' btmon-accent' : ''}`;
        this._heroIcon.opacity = online ? 255 : DIM;
        if (phase === 'ok') {
            this._heroMeta.text = `${online} of ${shown.length} devices connected` +
                (receivers.length ? ` · ${receivers.length === 1 ? '1 dongle' : `${receivers.length} dongles`}` : '');
        } else {
            this._heroMeta.text = {permission: 'Access needed', none: 'Nothing found'}[phase] ?? 'Looking for devices …';
        }
        const lowest = this._lowest(shown);
        this._pill.text = lowest !== null ? `Lowest battery ${lowest}%` : '';
        this._pill.visible = lowest !== null && this.page === 'main';

        this._heroButtons.destroy_all_children();
        if (this.page === 'main') {
            const hiddenCount = (stats.devices || []).length - shown.length;
            if (hiddenCount > 0 || this.showHidden) {
                const eye = button(this.showHidden ? '' : String(hiddenCount),
                    this.showHidden ? 'view-conceal-symbolic' : 'view-reveal-symbolic', () => {
                        this.showHidden = !this.showHidden;
                        this.rebuild();
                    });
                eye.accessible_name = this.showHidden ? 'Hide hidden devices' : `Show hidden devices (${hiddenCount})`;
                if (this.showHidden)
                    eye.add_style_pseudo_class('checked');
                this._heroButtons.add_child(eye);
            }
            const gear = button('', 'emblem-system-symbolic', () => this.setPage('settings'));
            gear.accessible_name = 'Settings';
            this._heroButtons.add_child(gear);
        }

        this._body.destroy_all_children();
        this._body.add_child(separator());
        if (this.page === 'settings')
            this._buildSettings();
        else if (this.page === 'bt')
            this._buildBluetooth();
        else
            this._buildMain(phase);
    }

    _lowest(devices) {
        let best = null;
        for (const d of devices) {
            const p = d.battery?.percent;
            if (d.online && p !== null && p !== undefined && (best === null || p < best))
                best = p;
        }
        return best;
    }

    _pageHeader(title, trailing = null) {
        const row = hbox({style_class: 'btmon-page-header'});
        row.add_child(button('Back', 'go-previous-symbolic', () => this.setPage('main')));
        row.add_child(label(title.toUpperCase(), 'btmon-section btmon-page-title', {x_expand: true}));
        if (trailing)
            row.add_child(trailing);
        this._body.add_child(row);
        this._body.add_child(separator());
    }

    // ------------------------------------------------------------ main page

    _buildMain(phase) {
        const ind = this._ind;
        const stats = ind.stats;
        if (phase === 'permission')
            this._body.add_child(this._setupCard());
        let message = '';
        if (phase === 'none')
            message = 'No Logitech receiver and no battery-powered Bluetooth device found.';
        else if (phase === 'error')
            message = `Error: ${String(stats.error || '')}`;
        else if (stats.message_code && MESSAGES[stats.message_code])
            message = MESSAGES[stats.message_code](...(Array.isArray(stats.message_args) ? stats.message_args : []));
        if (message) {
            const l = wrapping(label(message, phase === 'none' ? 'btmon-caption' : 'btmon-caption btmon-warning'));
            if (phase === 'none')
                dimmed(l);
            this._body.add_child(l);
        }

        const devices = this.showHidden ? (stats.devices || []) : ind.shownDevices();
        const links = this._links(devices);
        if (links.length) {
            this._body.add_child(sectionHeader('Connections'));
            this._body.add_child(this._tree(links));
            this._body.add_child(wrapping(dimmed(label('Dotted line: radio link. Solid line: plugged in or built in.', 'btmon-hint'))));
            this._body.add_child(separator());
        }
        if (devices.length) {
            this._body.add_child(sectionHeader('Devices'));
            for (const d of devices)
                this._body.add_child(this._card(d));
            this._body.add_child(separator());
        }
        const footer = hbox({style_class: 'btmon-footer'});
        footer.add_child(button('Refresh', 'view-refresh-symbolic', () => ind.send({cmd: 'refresh'})));
        footer.add_child(button('Bluetooth', 'bluetooth-active-symbolic', () => this.setPage('bt')));
        this._body.add_child(footer);
    }

    _setupCard() {
        const ind = this._ind;
        const card = vbox({style_class: 'btmon-setup'});
        card.add_child(label('Not ready yet · step 1 of 1', 'btmon-strong'));
        card.add_child(wrapping(label('Linux only lets root talk to the receivers. Allowing access installs one udev rule ' +
            '(the same one Solaar uses) that gives the logged-in user access to Logitech receivers and devices. ' +
            'You will be asked for your password once.', 'btmon-caption')));
        const allow = button(ind.allowing ? 'Waiting for password …' : 'Allow access', 'dialog-password-symbolic', () => ind.allowAccess());
        allow.reactive = !ind.allowing;
        allow.x_align = Clutter.ActorAlign.START;
        card.add_child(allow);
        return card;
    }

    // Every dongle (numbered when there are several of a kind), then each Bluetooth
    // adapter (built in, or a USB stick), then USB cable and other wireless devices.
    _links(devices) {
        const stats = this._ind.stats;
        const all = stats.devices || [];
        const receivers = stats.receivers || [];
        const out = [];
        const perFamily = {}, seen = {};
        for (const r of receivers)
            perFamily[r.family] = (perFamily[r.family] || 0) + 1;
        for (const rec of receivers) {
            seen[rec.family] = (seen[rec.family] || 0) + 1;
            const devs = devices.filter(d => d.receiver === rec.id);
            if (!devs.length && !this.showHidden)
                continue;
            const paired = all.filter(d => d.receiver === rec.id).length;
            out.push({
                type: 'dongle', label: (CONNECTIONS[rec.family] ?? 'Dongle') + (perFamily[rec.family] > 1 ? ` ${seen[rec.family]}` : ''),
                sub: `${paired} of ${rec.max_devices} slots`, devices: devs,
            });
        }
        const adapters = stats.adapters || [];
        const bt = devices.filter(d => !d.receiver && d.connection === 'bluetooth');
        adapters.forEach((ad, a) => {
            const mine = bt.filter(d => d.adapter === ad.id || (!d.adapter && a === 0));
            if (!mine.length && !this.showHidden)
                return;
            out.push({
                type: 'bluetooth', builtin: ad.builtin,
                label: ad.builtin ? 'Built-in Bluetooth' : `Bluetooth dongle${adapters.length > 1 ? ` ${a + 1}` : ''}`,
                sub: (ad.builtin ? 'Inside this PC' : 'USB stick') + (ad.vendor ? ` · ${ad.vendor}` : ''),
                devices: mine,
            });
        });
        const groups = adapters.length ? [] : [['bluetooth', 'Bluetooth adapter']];
        groups.push(['usb', 'USB cable'], ['wireless', 'Wireless']);
        for (const [code, name] of groups) {
            const list = devices.filter(d => !d.receiver && d.connection === code);
            if (list.length)
                out.push({type: code, label: name, sub: '', devices: list});
        }
        for (const link of out)
            link.online = link.devices.filter(d => d.online).length;
        return out;
    }

    // This PC, then each link on a solid line (plugged in), then its devices on dotted
    // lines (radio) with their battery.
    _tree(links) {
        const tree = vbox({style_class: 'btmon-tree'});
        const pc = hbox({style_class: 'btmon-tree-pc'});
        const pcBadge = new St.Bin({style_class: 'btmon-node btmon-node-pc', child: icon('computer-symbolic', 'btmon-node-icon')});
        pc.add_child(pcBadge);
        pc.add_child(label(`This PC  ·  ${GLib.get_host_name().slice(0, 40)}`, 'btmon-strong'));
        tree.add_child(pc);
        links.forEach((link, i) => {
            const live = link.online > 0;
            const row = hbox({style_class: 'btmon-link'});
            // The trunk down from the PC: through every link, ending at the last one's branch.
            const last = i === links.length - 1;
            row.add_child(new St.Widget({style_class: `btmon-trunk${last ? ' btmon-trunk-last' : ''}`,
                y_expand: !last, y_align: last ? Clutter.ActorAlign.START : Clutter.ActorAlign.FILL}));
            const branch = new St.Widget({style_class: `btmon-branch${live ? ' btmon-live' : ''}`, y_align: Clutter.ActorAlign.START});
            row.add_child(branch);
            const iconName = {dongle: 'media-removable-symbolic', bluetooth: 'bluetooth-active-symbolic',
                usb: 'media-removable-symbolic'}[link.type] ?? 'network-wireless-symbolic';
            const badge = new St.Bin({style_class: `btmon-node btmon-link-node${live ? ' btmon-node-live' : ''}`, child: icon(iconName, 'btmon-node-icon'),
                y_align: Clutter.ActorAlign.START});
            row.add_child(badge);
            const text = vbox({x_expand: false, style_class: 'btmon-link-text', y_align: Clutter.ActorAlign.START});
            const name = label(link.label, 'btmon-caption');
            if (!live)
                dimmed(name);
            text.add_child(name);
            if (link.sub)
                text.add_child(dimmed(label(link.sub, 'btmon-hint')));
            row.add_child(text);
            const chips = vbox({style_class: 'btmon-chips'});
            for (const d of link.devices)
                chips.add_child(this._chip(d));
            row.add_child(chips);
            tree.add_child(row);
        });
        return tree;
    }

    _chip(d) {
        const ind = this._ind;
        const row = hbox({style_class: 'btmon-chip-row'});
        if (ind.isHidden(d))
            row.opacity = 128;
        row.add_child(label('····', `btmon-dots${d.online ? ' btmon-accent' : ''}`));
        const chip = hbox({style_class: `btmon-chip${d.online ? ' btmon-chip-online' : ''}`});
        const kind = icon(kindIcon(d.kind), 'btmon-chip-icon');
        const name = label(deviceName(d), 'btmon-caption', {x_expand: true});
        if (!d.online) {
            dimmed(kind);
            dimmed(name);
        }
        chip.add_child(kind);
        chip.add_child(name);
        if (!d.online) {
            chip.add_child(dimmed(label('off', 'btmon-caption')));
        } else if (d.battery) {
            const color = ind.batteryColor(d.battery);
            const b = icon(batteryIcon(d.battery), 'btmon-chip-icon');
            const t = label(batteryText(d.battery), 'btmon-caption btmon-value');
            if (color) {
                b.style = `color: ${color};`;
                t.style = `color: ${color};`;
            }
            chip.add_child(b);
            chip.add_child(t);
        }
        row.add_child(chip);
        return row;
    }

    _statusLine(d) {
        const where = (CONNECTIONS[d.connection] ?? '') + (d.slot ? ` · slot ${d.slot}` : '');
        if (!d.online)
            return `${where} · not connected`;
        const b = d.battery;
        if (b?.charging)
            return `${where} · charging`;
        if (b && b.status === 'full' && b.external_power)
            return `${where} · charged`;
        if (!b)
            return `${where} · no battery reading`;
        return where;
    }

    // One card per device: badge, name and connection, battery, the eye to hide it, and
    // (Logitech devices) its settings when expanded.
    _card(d) {
        const ind = this._ind;
        const hidden = ind.isHidden(d);
        const settings = d.online && hasSettings(d);
        const open = settings && this.expanded.has(d.id);
        const card = vbox({style_class: `btmon-card${d.online ? ' btmon-card-online' : ''}`});
        if (hidden)
            card.opacity = 140;

        const head = hbox();
        const main = hbox({style_class: 'btmon-card-main'});
        const badge = new St.Bin({style_class: `btmon-badge${d.online ? ' btmon-badge-online' : ''}`, child: icon(kindIcon(d.kind), 'btmon-badge-icon')});
        main.add_child(badge);
        const names = vbox({y_align: Clutter.ActorAlign.CENTER});
        const name = label(deviceName(d), 'btmon-name');
        if (!d.online)
            dimmed(name);
        names.add_child(name);
        names.add_child(dimmed(label(this._statusLine(d) + (hidden ? ' · hidden' : ''), 'btmon-caption')));
        main.add_child(names);
        if (d.online && d.battery) {
            const color = ind.batteryColor(d.battery);
            const b = icon(batteryIcon(d.battery), 'btmon-icon');
            const t = label(batteryText(d.battery), 'btmon-caption btmon-value');
            if (color) {
                b.style = `color: ${color};`;
                t.style = `color: ${color};`;
            }
            main.add_child(b);
            main.add_child(t);
        }
        if (settings)
            main.add_child(dimmed(icon(open ? 'pan-down-symbolic' : 'pan-end-symbolic', 'btmon-chevron')));
        const mainButton = new St.Button({style_class: 'btmon-card-button', child: main, x_expand: true, reactive: settings, can_focus: settings});
        mainButton.connect('clicked', () => {
            if (this.expanded.has(d.id))
                this.expanded.delete(d.id);
            else
                this.expanded.add(d.id);
            this.rebuild();
        });
        head.add_child(mainButton);
        const eye = button('', hidden ? 'view-reveal-symbolic' : 'view-conceal-symbolic', () => ind.setHidden(d, !hidden));
        eye.add_style_class_name('btmon-eye');
        eye.accessible_name = hidden ? 'Show in list' : 'Hide from list';
        head.add_child(eye);
        card.add_child(head);
        if (open)
            this._settings(card, d);
        return card;
    }

    _settings(card, d) {
        const ind = this._ind;
        const set = (key, value) => ind.send({cmd: 'set', device: d.id, key, value});
        card.add_child(separator());
        if (d.dpi && d.dpi.max > 0) {
            const box = vbox({style_class: 'btmon-group'});
            const head = hbox();
            head.add_child(label('Pointer speed (DPI)', 'btmon-caption', {x_expand: true}));
            const fmt = v => `${v}${v === d.dpi.default ? ' · default' : ''}`;
            const s = new StepSlider(d.dpi.min, d.dpi.max, d.dpi.step, d.dpi.value, fmt, v => set('dpi', v), this);
            head.add_child(s.valueLabel);
            if (d.dpi.default && d.dpi.value !== d.dpi.default) {
                const reset = button('Default', '', () => set('dpi', d.dpi.default));
                reset.add_style_class_name('btmon-small');
                head.add_child(reset);
            }
            box.add_child(head);
            box.add_child(s.slider);
            card.add_child(box);
        }
        if (d.smartshift) {
            const box = vbox({style_class: 'btmon-group'});
            box.add_child(label('Scroll wheel mode', 'btmon-caption'));
            box.add_child(choices([
                {value: 'smartshift', label: 'SmartShift'},
                {value: 'ratchet', label: 'Ratchet'},
                {value: 'freespin', label: 'Free spin'},
            ], d.smartshift.mode, v => set('smartshift', v)));
            if (d.smartshift.mode === 'smartshift') {
                const row = hbox({style_class: 'btmon-slider-row'});
                row.add_child(label('Sensitivity', 'btmon-caption'));
                const s = new StepSlider(1, 50, 1, d.smartshift.threshold || 10, v => String(v), v => set('threshold', v), this);
                row.add_child(s.slider);
                row.add_child(s.valueLabel);
                box.add_child(row);
                box.add_child(wrapping(dimmed(label('Lower values switch to free spin with a gentler flick.', 'btmon-hint'))));
            }
            card.add_child(box);
        }
        if (d.wheel) {
            card.add_child(settingRow('Natural scrolling', 'Content follows the wheel, like on a touchpad',
                toggle(!!d.wheel.invert, on => set('invert', on))));
            card.add_child(settingRow('High-resolution scrolling', 'Smoother, finer steps in apps that support it',
                toggle(!!d.wheel.hires, on => set('hires', on))));
        }
        if (d.fnswap) {
            card.add_child(settingRow('Swap Fn keys',
                d.fnswap.on ? 'On: top row gives media and special functions, hold Fn for F1–F12'
                    : 'Off: top row gives F1–F12, hold Fn for media and special functions',
                toggle(!!d.fnswap.on, on => set('fnswap', on))));
        }
    }

    // ------------------------------------------------------------ settings page

    _buildSettings() {
        const ind = this._ind;
        const s = ind.settings;
        this._pageHeader('Settings');
        const pct = v => ({value: v, label: `${v}%`});
        this._body.add_child(settingRow('Low battery warning', 'At this level or less the icon turns orange',
            choices([15, 20, 25, 30, 40, 50].map(pct), s.get_int('low-at'), v => s.set_int('low-at', v)), true));
        this._body.add_child(settingRow('Critical battery warning', 'At this level or less the icon turns red',
            choices([5, 10, 15, 20].map(pct), s.get_int('critical-at'), v => s.set_int('critical-at', v)), true));
        this._body.add_child(settingRow('Other Bluetooth devices', 'Trackpads, earphones, controllers and more (battery only)',
            toggle(s.get_boolean('other-devices'), on => s.set_boolean('other-devices', on))));
        const missing = (ind.stats.denied || []).length > 0;
        let control = new St.Widget();
        if (missing) {
            control = button(ind.allowing ? 'Waiting for password …' : 'Allow access', 'dialog-password-symbolic', () => ind.allowAccess());
            control.reactive = !ind.allowing;
        }
        this._body.add_child(settingRow('Receiver access', missing ? 'Not granted' : 'Granted', control));
    }

    // ------------------------------------------------------------ Bluetooth page

    _buildBluetooth() {
        const ind = this._ind;
        const bt = ind.bluetooth;
        let trailing = null;
        if (bt.hasAdapter) {
            trailing = hbox({x_expand: false, style_class: 'btmon-power'});
            const state = label(ind.scanning ? 'Scanning' : bt.powered ? 'On' : 'Off', `btmon-caption${ind.scanning ? ' btmon-accent' : ''}`);
            if (!ind.scanning)
                dimmed(state);
            trailing.add_child(state);
            const power = toggle(bt.powered, on => ind.btPower(on));
            power.accessible_name = bt.powered ? 'Turn Bluetooth off' : 'Turn Bluetooth on';
            trailing.add_child(power);
        }
        this._pageHeader('Bluetooth', trailing);
        const rows = bt.rows(ind.scanning);
        const titles = {connected: 'Connected', paired: 'Paired', available: 'Available'};
        let any = false;
        for (const section of ['connected', 'paired', 'available']) {
            if (!rows[section].length)
                continue;
            if (any)
                this._body.add_child(separator());
            any = true;
            this._body.add_child(sectionHeader(titles[section]));
            for (const row of rows[section])
                this._body.add_child(this._btRow(row));
        }
        if (!any || (ind.scanning && !rows.available.length)) {
            const text = !bt.hasAdapter ? 'No Bluetooth adapter' : !bt.powered ? 'Turn Bluetooth on to scan' : 'Scanning for devices…';
            this._body.add_child(wrapping(dimmed(label(text, 'btmon-caption'))));
        }
    }

    _btRow(row) {
        const ind = this._ind;
        const pending = ind.btPending.get(row.address)?.action ?? '';
        const asking = this.confirmForget === row.address;
        const box = hbox({style_class: 'btmon-bt-row'});
        const kind = icon(bluezIcon(row.icon, row.connected), 'btmon-bt-icon');
        if (row.connected)
            kind.add_style_class_name('btmon-accent');
        else
            dimmed(kind);
        box.add_child(kind);
        const text = vbox({y_align: Clutter.ActorAlign.CENTER});
        text.add_child(label(row.name, 'btmon-name'));
        const status = pending === 'forgetting' ? 'Forgetting…'
            : pending === 'disconnecting' ? 'Disconnecting…'
                : pending === 'connecting' ? 'Connecting…'
                    : row.connected && row.battery >= 0 ? `${row.battery} %` : '';
        if (status) {
            const st = label(status, 'btmon-caption');
            if (pending)
                st.add_style_class_name('btmon-accent');
            else
                dimmed(st);
            text.add_child(st);
        }
        box.add_child(text);
        const actions = hbox({x_expand: false, style_class: 'btmon-bt-actions'});
        if (row.section !== 'available') {
            const forget = button(asking ? 'Really forget?' : '', 'user-trash-symbolic', () => {
                if (this.confirmForget !== row.address) {
                    this.confirmForget = row.address;
                    this.rebuild();
                    return;
                }
                this.confirmForget = '';
                ind.btAction('forget', row.address, 'forgetting');
            });
            forget.accessible_name = 'Forget';
            if (asking)
                forget.add_style_class_name('btmon-danger');
            forget.reactive = !pending;
            actions.add_child(forget);
        }
        const main = row.connected
            ? button('Disconnect', 'bluetooth-disabled-symbolic', () => ind.btAction('disconnect', row.address, 'disconnecting'))
            : button(row.section === 'available' ? 'Pair' : 'Connect', 'bluetooth-active-symbolic',
                () => ind.btAction(row.section === 'available' ? 'pair' : 'connect', row.address, 'connecting'));
        main.reactive = !pending;
        if (pending)
            main.opacity = DIM;
        actions.add_child(main);
        box.add_child(actions);
        return box;
    }
}

// ---------------------------------------------------------------------------------- indicator

const Indicator = GObject.registerClass(
class BluetoothMonitorIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Bluetooth Monitor', false);
        this._extension = extension;
        this.settings = extension.getSettings();
        this.stats = {};
        this.allowing = false;
        this.scanning = false;
        this.btPending = new Map();   // address -> {action, timer}
        this.add_style_class_name('btmon-button-panel');

        // Only the left button opens the menu; the right one refreshes.
        this._clickGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        const rightClick = new Clutter.ClickGesture({required_button: Clutter.BUTTON_SECONDARY});
        rightClick.set_recognize_on_press(true);
        rightClick.connect('recognize', () => this.send({cmd: 'refresh'}));
        this.add_action(rightClick);

        this._icon = new St.Icon({icon_name: 'input-mouse-symbolic', style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._panel = new DetailPanel(this);
        this._scroll = new St.ScrollView({
            style_class: 'btmon-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._scroll.child = this._panel.actor;
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(this._scroll);
        this.menu.addMenuItem(item);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
                const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                this._scroll.style = `max-height: ${Math.max(240, Math.round(workArea.height / scale) - 100)}px;`;
            } else {
                this._panel.reset();
            }
            this._panel.rebuild();
            this.send({cmd: open ? 'open' : 'closed'});
            this.syncScan();
        });
        // Backspace goes back from the settings and Bluetooth pages (Esc closes the menu).
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            if (symbol === Clutter.KEY_BackSpace && this._panel.page !== 'main') {
                this._panel.setPage('main');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.menu.actor.add_action(keys);

        this.bluetooth = new BluetoothModel(() => this._onBluetooth());
        this._settingsIds = ['low-at', 'critical-at', 'hidden'].map(key =>
            this.settings.connect(`changed::${key}`, () => this._refresh()));
        this._settingsIds.push(this.settings.connect('changed::other-devices', () => {
            this.send({cmd: 'options', other_devices: this.settings.get_boolean('other-devices')});
            this._refresh();
        }));
        this._render();
    }

    // ------------------------------------------------------------ data

    setStats(stats) {
        // The collector sends a snapshot on every scan; one that only changed its time
        // does not rebuild the panel (keeps hover and focus where they are).
        const {updated: _updated, ...rest} = stats;
        const key = JSON.stringify(rest);
        this.stats = stats;
        if (key === this._statsKey)
            return;
        this._statsKey = key;
        this._refresh();
    }

    _refresh() {
        this._render();
        if (this.menu.isOpen)
            this._panel.rebuild();
    }

    // The collector (re)started: tell it the options and whether the panel is open.
    onCollectorStart() {
        this.send({cmd: 'options', other_devices: this.settings.get_boolean('other-devices')});
        if (this.menu.isOpen)
            this.send({cmd: 'open'});
    }

    send(obj) {
        this._extension.collector?.send(obj);
    }

    hidden() {
        return this.settings.get_strv('hidden').slice(0, 500);
    }

    isHidden(d) {
        return this.hidden().includes(deviceKey(d));
    }

    setHidden(d, on) {
        const key = deviceKey(d);
        if (!key)
            return;
        const next = this.hidden().filter(k => k !== key);
        if (on)
            next.push(key);
        next.sort();
        this.settings.set_strv('hidden', next);
    }

    shownDevices() {
        const hidden = this.hidden();
        return (this.stats.devices || []).filter(d => !hidden.includes(deviceKey(d)));
    }

    // 'ok' | 'low' | 'critical' for a battery (percent if known, else its level).
    batteryState(b) {
        if (!b || b.charging)
            return 'ok';
        const low = this.settings.get_int('low-at');
        const critical = this.settings.get_int('critical-at');
        const p = b.percent;
        if (p !== null && p !== undefined)
            return p <= critical ? 'critical' : p <= low ? 'low' : 'ok';
        return b.level === 'critical' || b.level === 'empty' ? 'critical' : b.level === 'low' ? 'low' : 'ok';
    }

    // A colour only for warnings and charging; a fine battery keeps the text colour.
    batteryColor(b) {
        if (!b)
            return null;
        if (b.charging)
            return COLORS.ok;
        const s = this.batteryState(b);
        return s === 'ok' ? null : COLORS[s];
    }

    // The worst state among connected devices and the kind of device it belongs to; on a
    // tie (or while all is fine) a mouse wins.
    _alert(devices) {
        const rank = {ok: 0, low: 1, critical: 2};
        let best = {state: 'ok', kind: 'mouse'};
        for (const d of devices) {
            if (!d.online)
                continue;
            const s = this.batteryState(d.battery);
            if (rank[s] > rank[best.state] || (rank[s] === rank[best.state] && rank[s] > 0 && d.kind === 'mouse'))
                best = {state: s, kind: d.kind};
        }
        return best;
    }

    _render() {
        const devices = this.shownDevices();
        const online = devices.filter(d => d.online).length;
        const alert = this._alert(devices);
        this._icon.icon_name = kindIcon(alert.kind);
        this._icon.style = online ? `color: ${COLORS[alert.state]};` : '';
        this._icon.opacity = online ? 255 : DIM;
    }

    // ------------------------------------------------------------ receiver access

    // One polkit prompt installs the uaccess udev rule (scripts/allow-access.sh).
    allowAccess() {
        if (this.allowing)
            return;
        const script = this._extension.script('allow-access.sh');
        const proc = this._extension.spawn(['pkexec', '/bin/bash', script]);
        if (!proc)
            return;
        this.allowing = true;
        this._refresh();
        proc.wait_async(null, () => {
            if (!this._extension.collector)
                return;     // disabled meanwhile
            this.allowing = false;
            this.send({cmd: 'refresh'});
            this._refresh();
        });
    }

    // ------------------------------------------------------------ Bluetooth

    _onBluetooth() {
        // Finished actions leave the pending list; a headset that connected becomes the output.
        for (const [address, entry] of [...this.btPending]) {
            const d = this.bluetooth.find(address);
            const done = (entry.action === 'connecting' && d?.connected) ||
                (entry.action === 'disconnecting' && d && !d.connected) ||
                (entry.action === 'forgetting' && (!d || !d.known));
            if (!done)
                continue;
            this._clearPending(address);
            if (entry.action === 'connecting')
                this._extension.spawn(['python3', '-I', this._extension.script('audio-default.py'), address]);
        }
        this.syncScan();
        if (this.menu.isOpen && this._panel.page === 'bt')
            this._panel.rebuild();
    }

    _clearPending(address) {
        const entry = this.btPending.get(address);
        if (entry?.timer)
            GLib.source_remove(entry.timer);
        this.btPending.delete(address);
    }

    btAction(action, address, pending) {
        if (!ADDRESS_RE.test(address) || this.btPending.has(address))
            return;
        if (!this._extension.spawn(['bash', this._extension.script('bt-device.sh'), action, address]))
            return;
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PENDING_TIMEOUT, () => {
            this.btPending.delete(address);
            if (this.menu.isOpen)
                this._panel.rebuild();
            return GLib.SOURCE_REMOVE;
        });
        this.btPending.set(address, {action: pending, timer});
        this._panel.rebuild();
    }

    btPower(on) {
        this._extension.spawn(['bash', this._extension.script('bt-power.sh'), on ? 'on' : 'off']);
    }

    // Scan only while the Bluetooth page is on screen, through bluetoothctl's own discovery
    // session: BlueZ ends it the moment the process exits, so closing the page, the menu or
    // the extension always stops it (an endless scan makes Bluetooth audio stutter).
    syncScan() {
        const want = !!this.menu.isOpen && this._panel.page === 'bt' && this.bluetooth.powered;
        if (want && !this._scanProc && !this._scanRetry) {
            this._scanProc = this._extension.spawn(['bluetoothctl', '--timeout', String(SCAN_SECONDS), 'scan', 'on']);
            if (!this._scanProc)
                return;
            const proc = this._scanProc;
            proc.wait_async(null, () => {
                if (this._scanProc !== proc)
                    return;
                this._scanProc = null;
                this._setScanning(false);
                // Still wanted after the timeout (or a failure): start again, but not in a tight loop.
                this._scanRetry = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                    this._scanRetry = 0;
                    this.syncScan();
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._setScanning(true);
        } else if (!want) {
            this.stopScan();
        }
    }

    stopScan() {
        if (this._scanRetry)
            GLib.source_remove(this._scanRetry);
        this._scanRetry = 0;
        const proc = this._scanProc;
        this._scanProc = null;
        proc?.force_exit();
        this._setScanning(false);
    }

    _setScanning(on) {
        if (this.scanning === on)
            return;
        this.scanning = on;
        if (this.menu.isOpen && this._panel.page === 'bt')
            this._panel.rebuild();
    }

    _onDestroy() {
        this.stopScan();
        for (const address of [...this.btPending.keys()])
            this._clearPending(address);
        for (const id of this._settingsIds)
            this.settings.disconnect(id);
        this.bluetooth.destroy();
        super._onDestroy();
    }
});

// ---------------------------------------------------------------------------------- extension

export default class BluetoothMonitorExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this.collector = new Collector(this.script('bluetooth-monitor.py'),
            stats => this._indicator?.setStats(stats), () => this._indicator?.onCollectorStart());
        this.collector.start();
    }

    disable() {
        this.collector?.stop();
        this.collector = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    script(name) {
        return this.dir.get_child('scripts').get_child(name).get_path();
    }

    spawn(argv) {
        try {
            return Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`[Bluetooth Monitor] ${argv[0]}: ${e.message}`);
            return null;
        }
    }
}
