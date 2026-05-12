'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SETTINGS_PROCESS_PATTERN = 'process-pattern';
const SETTINGS_REFRESH_RATE = 'refresh-rate';
const SETTINGS_POSITION = 'position';
const SETTINGS_SERVER_NAMES = 'server-names';
const SETTINGS_SERVER_COMMANDS = 'server-commands';
const SETTINGS_SERVER_WORKDIRS = 'server-workdirs';
const SETTINGS_SERVER_PATTERNS = 'server-patterns';
const SETTINGS_SELECTED_SERVER = 'selected-server';
const DEFAULT_PROCESS_PATTERN = '[l]lama-server';
const PROFILE_SETTING_KEYS = [
    SETTINGS_SERVER_NAMES,
    SETTINGS_SERVER_COMMANDS,
    SETTINGS_SERVER_WORKDIRS,
    SETTINGS_SERVER_PATTERNS,
    SETTINGS_SELECTED_SERVER,
];
const PANEL_SETTING_KEYS = [
    'show-status',
    'show-eval-tps',
    'show-prompt-tps',
    'show-eval-tokens',
    'show-prompt-tokens',
    'show-total-tokens',
    'show-total-time',
    'show-slot-task',
];

function _formatNumber(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value))
        return '-';

    return value.toFixed(digits);
}

function _formatMs(value) {
    if (value === null || value === undefined || Number.isNaN(value))
        return '-';

    if (value >= 1000)
        return `${(value / 1000).toFixed(2)} s`;

    return `${value.toFixed(0)} ms`;
}

function _exec(argv) {
    let proc = new Gio.Subprocess({
        argv,
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    proc.init(null);

    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, null, (proc_, res) => {
            try {
                let [, stdout, stderr] = proc_.communicate_utf8_finish(res);
                let status = proc_.get_exit_status();

                if (status !== 0)
                    reject(new Error(stderr ? stderr.trim() : `Exited with status ${status}`));
                else
                    resolve(stdout.trim());
            } catch (e) {
                reject(e);
            }
        });
    });
}

function _valueAt(values, index, fallback = '') {
    if (index < values.length && values[index] !== undefined)
        return values[index];

    return fallback;
}

const MetricRow = GObject.registerClass(
class MetricRow extends PopupMenu.PopupBaseMenuItem {
    _init(name, value = '-') {
        super._init({
            reactive: false,
            can_focus: false,
        });

        this._name = new St.Label({
            text: name,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._value = new St.Label({
            text: value,
            style_class: 'llamacpp-menu-value',
            x_align: Clutter.ActorAlign.END,
        });

        this.add_child(this._name);
        this.add_child(this._value);
    }

    setValue(value) {
        this._value.text = value;
    }
});

const LlamaCppIndicator = GObject.registerClass(
class LlamaCppIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'llama.cpp Server Monitor');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._process = null;
        this._readCancellable = null;
        this._statusTimeoutId = 0;
        this._settingsSignals = [];

        this._resetMetrics('Stopped');

        this._buildPanel();
        this._buildMenu();
        this._connectSettings();
        this._rebuildServerMenu();
        this._refreshProcessStatus();
        this._restartStatusTimer();
    }

    _buildPanel() {
        let box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({
            text: 'LLM -',
            style_class: 'llamacpp-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        box.add_child(PopupMenu.arrowIcon(St.Side.BOTTOM));
        this.add_child(box);
    }

    _buildMenu() {
        this._rows = {
            status: new MetricRow('Status'),
            pid: new MetricRow('PID'),
            evalTps: new MetricRow('Generation TPS'),
            promptTps: new MetricRow('Prompt TPS'),
            evalTokens: new MetricRow('Generated tokens'),
            promptTokens: new MetricRow('Prompt tokens'),
            totalTokens: new MetricRow('Total tokens'),
            totalTime: new MetricRow('Total time'),
            task: new MetricRow('Task'),
            slot: new MetricRow('Slot'),
            truncated: new MetricRow('Truncated'),
        };

        for (let key of [
            'status',
            'pid',
            'evalTps',
            'promptTps',
            'evalTokens',
            'promptTokens',
            'totalTokens',
            'totalTime',
            'task',
            'slot',
            'truncated',
        ])
            this.menu.addMenuItem(this._rows[key]);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._serverMenu = new PopupMenu.PopupSubMenuMenuItem('Server');
        this.menu.addMenuItem(this._serverMenu);

        this._startItem = new PopupMenu.PopupMenuItem('Start server');
        this._startItem.connect('activate', () => this._startServer());
        this.menu.addMenuItem(this._startItem);

        this._stopItem = new PopupMenu.PopupMenuItem('Stop server');
        this._stopItem.connect('activate', () => this._stopServer());
        this.menu.addMenuItem(this._stopItem);

        this._prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        this._prefsItem.connect('activate', () => {
            let extensionObject = Extension.lookupByURL(import.meta.url);
            extensionObject.openPreferences();
        });
        this.menu.addMenuItem(this._prefsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._lastLine = new MetricRow('Last log', '-');
        this.menu.addMenuItem(this._lastLine);

        this._renderMetrics();
    }

    _connectSettings() {
        this._settingsSignals.push(this._settings.connect(`changed::${SETTINGS_REFRESH_RATE}`, () => {
            this._restartStatusTimer();
        }));
        this._settingsSignals.push(this._settings.connect(`changed::${SETTINGS_POSITION}`, () => {
            this._updatePanelPosition();
        }));
        for (let key of PANEL_SETTING_KEYS) {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, () => {
                this._renderMetrics();
            }));
        }
        for (let key of PROFILE_SETTING_KEYS) {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, () => {
                this._rebuildServerMenu();
                this._refreshProcessStatus();
            }));
        }
    }

    _restartStatusTimer() {
        if (this._statusTimeoutId) {
            GLib.source_remove(this._statusTimeoutId);
            this._statusTimeoutId = 0;
        }

        let seconds = this._settings.get_int(SETTINGS_REFRESH_RATE);
        this._statusTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refreshProcessStatus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _startServer() {
        if (this._process)
            return;

        let profile = this._getSelectedProfile();
        let command = profile ? profile.command.trim() : '';
        let workdir = profile ? profile.workdir.trim() : '';

        if (!command) {
            Main.notifyError('llama.cpp monitor', 'No server profile command configured.');
            return;
        }

        try {
            let launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            });

            if (workdir)
                launcher.set_cwd(workdir);

            this._process = launcher.spawnv(['bash', '-lc', command]);
            this._readCancellable = new Gio.Cancellable();

            this._resetMetrics('Starting');
            this._metrics.pid = this._process.get_identifier() || '-';
            this._renderMetrics();

            this._readProcessOutput();
            this._process.wait_async(null, (proc, res) => {
                try {
                    proc.wait_finish(res);
                } catch (e) {
                    logError(e);
                }

                this._process = null;
                this._readCancellable = null;
                this._resetMetrics('Stopped');
                this._renderMetrics();
                this._refreshProcessStatus();
            });
        } catch (e) {
            Main.notifyError('Failed to start llama.cpp server', e.message);
            this._process = null;
            this._readCancellable = null;
            this._resetMetrics('Stopped');
            this._renderMetrics();
        }
    }

    _readProcessOutput() {
        if (!this._process)
            return;

        let stream = new Gio.DataInputStream({
            base_stream: this._process.get_stdout_pipe(),
        });

        let readNext = () => {
            if (!this._process || !this._readCancellable || this._readCancellable.is_cancelled())
                return;

            stream.read_line_async(GLib.PRIORITY_DEFAULT, this._readCancellable, (stream_, res) => {
                try {
                    let [line] = stream_.read_line_finish_utf8(res);
                    if (line === null)
                        return;

                    this._handleLogLine(line);
                    readNext();
                } catch (e) {
                    if (!this._readCancellable || !this._readCancellable.is_cancelled())
                        logError(e);
                }
            });
        };

        readNext();
    }

    _handleLogLine(line) {
        this._metrics.lastLine = line.trim();

        let pidMatch = line.match(/^\[(\d+)\]/);
        if (pidMatch)
            this._metrics.pid = pidMatch[1];

        let timingMatch = line.match(/slot print_timing:\s+id\s+(\d+)\s+\|\s+task\s+(\d+)/);
        if (timingMatch) {
            this._metrics.slot = timingMatch[1];
            this._metrics.task = timingMatch[2];
            this._metrics.status = 'Timing';
        }

        let promptMatch = line.match(/prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second/);
        if (promptMatch) {
            this._metrics.promptTokens = Number.parseInt(promptMatch[2], 10);
            this._metrics.promptTps = Number.parseFloat(promptMatch[3]);
            this._metrics.status = 'Prompt done';
        }

        let evalMatch = line.match(/^\[[^\]]+\]\s+eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second/);
        if (evalMatch) {
            this._metrics.evalTokens = Number.parseInt(evalMatch[2], 10);
            this._metrics.evalTps = Number.parseFloat(evalMatch[3]);
            this._metrics.status = 'Generation done';
        }

        let totalMatch = line.match(/total time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/);
        if (totalMatch) {
            this._metrics.totalTimeMs = Number.parseFloat(totalMatch[1]);
            this._metrics.totalTokens = Number.parseInt(totalMatch[2], 10);
        }

        let releaseMatch = line.match(/slot\s+release:.*n_tokens\s*=\s*(\d+),\s*truncated\s*=\s*(\d+)/);
        if (releaseMatch) {
            this._metrics.totalTokens = Number.parseInt(releaseMatch[1], 10);
            this._metrics.truncated = releaseMatch[2] === '0' ? 'No' : 'Yes';
        }

        if (line.includes('update_slots: all slots are idle'))
            this._metrics.status = 'Idle';
        else if (line.includes('update_slots:'))
            this._metrics.status = 'Busy';

        this._renderMetrics();
    }

    _stopServer() {
        if (this._readCancellable)
            this._readCancellable.cancel();

        if (this._process) {
            this._process.force_exit();
            this._resetMetrics('Stopping');
            this._renderMetrics();
            return;
        }

        let pattern = this._getSelectedProcessPattern();
        if (!pattern)
            return;

        _exec(['pkill', '-f', pattern])
            .then(() => {
                this._resetMetrics('Stopped');
                this._renderMetrics();
            })
            .catch(e => {
                this._metrics.status = 'Stop failed';
                this._renderMetrics();
                Main.notifyError('Failed to stop llama.cpp server', e.message);
            });
    }

    _refreshProcessStatus() {
        if (this._process)
            return;

        let pattern = this._getSelectedProcessPattern();
        if (!pattern) {
            this._resetMetrics('Unknown');
            this._renderMetrics();
            return;
        }

        _exec(['pgrep', '-af', pattern])
            .then(output => {
                let firstLine = output.split('\n').find(line => line.trim()) || '';
                let pid = firstLine.split(/\s+/, 1)[0];

                if (pid) {
                    this._metrics.status = 'Running external';
                    this._metrics.pid = pid;
                } else {
                    this._resetMetrics('Stopped');
                }
                this._renderMetrics();
            })
            .catch(() => {
                this._resetMetrics('Stopped');
                this._renderMetrics();
            });
    }

    _resetMetrics(status) {
        this._metrics = {
            status,
            pid: '-',
            slot: '-',
            task: '-',
            promptTokens: null,
            promptTps: null,
            evalTokens: null,
            evalTps: null,
            totalTokens: null,
            totalTimeMs: null,
            lastLine: '-',
            truncated: '-',
        };
    }

    _getProfiles() {
        let names = this._settings.get_strv(SETTINGS_SERVER_NAMES);
        let commands = this._settings.get_strv(SETTINGS_SERVER_COMMANDS);
        let workdirs = this._settings.get_strv(SETTINGS_SERVER_WORKDIRS);
        let patterns = this._settings.get_strv(SETTINGS_SERVER_PATTERNS);
        let length = Math.max(names.length, commands.length, workdirs.length, patterns.length);
        let profiles = [];

        for (let i = 0; i < length; i++) {
            let command = _valueAt(commands, i).trim();
            let name = _valueAt(names, i).trim() || `Server ${i + 1}`;

            profiles.push({
                index: i,
                name,
                command,
                workdir: _valueAt(workdirs, i),
                pattern: _valueAt(patterns, i),
            });
        }

        return profiles;
    }

    _getSelectedProfile() {
        let profiles = this._getProfiles();
        if (profiles.length === 0)
            return null;

        let index = this._settings.get_int(SETTINGS_SELECTED_SERVER);
        if (index < 0 || index >= profiles.length)
            index = 0;

        return profiles[index];
    }

    _getSelectedProcessPattern() {
        let profile = this._getSelectedProfile();
        if (profile && profile.pattern.trim())
            return profile.pattern.trim();

        return this._settings.get_string(SETTINGS_PROCESS_PATTERN).trim() || DEFAULT_PROCESS_PATTERN;
    }

    _rebuildServerMenu() {
        if (!this._serverMenu)
            return;

        this._serverMenu.menu.removeAll();

        let profiles = this._getProfiles();
        let selected = this._settings.get_int(SETTINGS_SELECTED_SERVER);

        if (profiles.length === 0) {
            let item = new PopupMenu.PopupMenuItem('No servers configured', {
                reactive: false,
                can_focus: false,
            });
            this._serverMenu.label.text = 'Server: none';
            this._serverMenu.menu.addMenuItem(item);
            this._startItem.setSensitive(false);
            return;
        }

        if (selected < 0 || selected >= profiles.length)
            selected = 0;

        this._serverMenu.label.text = `Server: ${profiles[selected].name}`;
        this._startItem.setSensitive(Boolean(profiles[selected].command.trim()));

        for (let profile of profiles) {
            let item = new PopupMenu.PopupMenuItem(profile.name);

            if (profile.index === selected)
                item.setOrnament(PopupMenu.Ornament.DOT);

            item.connect('activate', () => {
                this._settings.set_int(SETTINGS_SELECTED_SERVER, profile.index);
            });
            this._serverMenu.menu.addMenuItem(item);
        }
    }

    _renderMetrics() {
        let evalText = this._metrics.evalTps === null
            ? '-'
            : `${_formatNumber(this._metrics.evalTps, 2)} tok/s`;
        let promptText = this._metrics.promptTps === null
            ? '-'
            : `${_formatNumber(this._metrics.promptTps, 2)} tok/s`;

        this._panelLabel.text = this._buildPanelText();

        this._rows.status.setValue(this._metrics.status);
        this._rows.pid.setValue(String(this._metrics.pid));
        this._rows.evalTps.setValue(evalText);
        this._rows.promptTps.setValue(promptText);
        this._rows.evalTokens.setValue(this._metrics.evalTokens === null ? '-' : String(this._metrics.evalTokens));
        this._rows.promptTokens.setValue(this._metrics.promptTokens === null ? '-' : String(this._metrics.promptTokens));
        this._rows.totalTokens.setValue(this._metrics.totalTokens === null ? '-' : String(this._metrics.totalTokens));
        this._rows.totalTime.setValue(_formatMs(this._metrics.totalTimeMs));
        this._rows.task.setValue(String(this._metrics.task));
        this._rows.slot.setValue(String(this._metrics.slot));
        this._rows.truncated.setValue(String(this._metrics.truncated));
        this._lastLine.setValue(this._metrics.lastLine.length > 80
            ? `${this._metrics.lastLine.slice(0, 77)}...`
            : this._metrics.lastLine);
    }

    _buildPanelText() {
        if (this._metrics.status === 'Stopped' ||
            this._metrics.status === 'Starting' ||
            this._metrics.status === 'Stopping' ||
            this._metrics.status === 'Unknown' ||
            this._metrics.status === 'Stop failed')
            return `LLM ${this._metrics.status.toLowerCase()}`;

        if (this._metrics.status === 'Running external' && !this._hasTimingMetrics())
            return 'LLM running';

        let parts = [];

        if (this._settings.get_boolean('show-status'))
            parts.push(this._metrics.status);

        if (this._settings.get_boolean('show-eval-tps') && this._metrics.evalTps !== null)
            parts.push(`gen ${_formatNumber(this._metrics.evalTps, 1)} t/s`);

        if (this._settings.get_boolean('show-prompt-tps') && this._metrics.promptTps !== null)
            parts.push(`prompt ${_formatNumber(this._metrics.promptTps, 0)} t/s`);

        if (this._settings.get_boolean('show-eval-tokens') && this._metrics.evalTokens !== null)
            parts.push(`out ${this._metrics.evalTokens}`);

        if (this._settings.get_boolean('show-prompt-tokens') && this._metrics.promptTokens !== null)
            parts.push(`ctx ${this._metrics.promptTokens}`);

        if (this._settings.get_boolean('show-total-tokens') && this._metrics.totalTokens !== null)
            parts.push(`tok ${this._metrics.totalTokens}`);

        if (this._settings.get_boolean('show-total-time') && this._metrics.totalTimeMs !== null)
            parts.push(`time ${_formatMs(this._metrics.totalTimeMs)}`);

        if (this._settings.get_boolean('show-slot-task') && this._metrics.slot !== '-' && this._metrics.task !== '-')
            parts.push(`s${this._metrics.slot}/t${this._metrics.task}`);

        if (parts.length === 0)
            return `LLM ${this._metrics.status.toLowerCase()}`;

        return parts.join(' | ');
    }

    _hasTimingMetrics() {
        return this._metrics.evalTps !== null ||
            this._metrics.promptTps !== null ||
            this._metrics.evalTokens !== null ||
            this._metrics.promptTokens !== null ||
            this._metrics.totalTokens !== null ||
            this._metrics.totalTimeMs !== null;
    }

    _updatePanelPosition() {
        if (!this.container || !this.container.get_parent())
            return;

        this.container.get_parent().remove_child(this.container);

        let boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };

        let pos = this.getPanelPosition();
        boxes[pos].insert_child_at_index(this.container, pos === 'right' ? 0 : -1);
    }

    getPanelPosition() {
        return ['left', 'center', 'right'][this._settings.get_int(SETTINGS_POSITION)];
    }

    destroy() {
        if (this._statusTimeoutId) {
            GLib.source_remove(this._statusTimeoutId);
            this._statusTimeoutId = 0;
        }

        if (this._readCancellable)
            this._readCancellable.cancel();

        for (let signal of this._settingsSignals)
            this._settings.disconnect(signal);

        this._settingsSignals = [];
        super.destroy();
    }
});

let indicator = null;

export default class LlamaCppMonitorExtension extends Extension {
    enable() {
        indicator = new LlamaCppIndicator(this);

        let pos = indicator.getPanelPosition();
        Main.panel.addToStatusArea('llamacpp-monitor', indicator, pos === 'right' ? 0 : -1, pos);
    }

    disable() {
        if (indicator) {
            indicator.destroy();
            indicator = null;
        }
    }
}
