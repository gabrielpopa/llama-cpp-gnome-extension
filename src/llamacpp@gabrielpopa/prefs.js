'use strict';

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const GENERAL_SETTINGS = {
    'process-pattern': {
        type: 'string',
        title: 'Default process pattern',
        subtitle: 'Fallback regex used when the selected server has no process pattern.',
    },
    'refresh-rate': {
        type: 'int',
        title: 'Refresh interval',
        subtitle: 'How often to refresh process status.',
        min: 1,
        max: 60,
    },
    position: {
        type: 'combo',
        title: 'Panel position',
        subtitle: 'Panel position for the indicator.',
        options: ['Left', 'Center', 'Right'],
    },
};

const PROFILE_KEYS = {
    names: 'server-names',
    commands: 'server-commands',
    workdirs: 'server-workdirs',
    patterns: 'server-patterns',
    selected: 'selected-server',
};

const PANEL_SETTINGS = {
    'show-status': {
        title: 'Status',
        subtitle: 'Show Busy, Idle, Stopped, or Running external.',
    },
    'show-eval-tps': {
        title: 'Generation TPS',
        subtitle: 'Show the latest generation tokens per second.',
    },
    'show-prompt-tps': {
        title: 'Prompt TPS',
        subtitle: 'Show the prompt processing tokens per second.',
    },
    'show-eval-tokens': {
        title: 'Generated tokens',
        subtitle: 'Show the latest output token count.',
    },
    'show-prompt-tokens': {
        title: 'Prompt tokens',
        subtitle: 'Show the latest prompt token count.',
    },
    'show-total-tokens': {
        title: 'Total tokens',
        subtitle: 'Show total tokens from the latest timing block.',
    },
    'show-total-time': {
        title: 'Total time',
        subtitle: 'Show total time from the latest timing block.',
    },
    'show-slot-task': {
        title: 'Slot and task',
        subtitle: 'Show the latest slot and task IDs.',
    },
};

let settings = null;
let selectedServerCombo = null;
let profileListBox = null;
let updatingUi = false;

export default class LlamaCppPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        settings = this.getSettings();

        let page = new Adw.PreferencesPage({
            title: 'llama.cpp',
            icon_name: 'utilities-system-monitor-symbolic',
        });

        let serverGroup = new Adw.PreferencesGroup({
            title: 'Servers',
        });
        serverGroup.add(_buildSelectedServerRow());
        profileListBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 12,
            margin_end: 12,
        });
        serverGroup.add(profileListBox);

        let addServerRow = new Adw.ActionRow({
            title: 'Add server',
            subtitle: 'Create a new llama-server command profile.',
        });
        let addServerButton = new Gtk.Button({
            label: 'Add',
            valign: Gtk.Align.CENTER,
        });
        addServerButton.connect('clicked', () => _addProfile());
        addServerRow.add_suffix(addServerButton);
        addServerRow.activatable_widget = addServerButton;
        serverGroup.add(addServerRow);

        let generalGroup = new Adw.PreferencesGroup({
            title: 'General',
        });
        for (let key in GENERAL_SETTINGS)
            generalGroup.add(_buildGeneralRow(key));

        let panelGroup = new Adw.PreferencesGroup({
            title: 'Panel Metrics',
            description: 'Select which values are shown directly in the top bar.',
        });
        for (let key in PANEL_SETTINGS)
            panelGroup.add(_buildSwitchRow(key));

        page.add(serverGroup);
        page.add(generalGroup);
        page.add(panelGroup);
        window.add(page);

        _renderProfiles();
    }
}

function _valueAt(values, index, fallback = '') {
    if (index < values.length && values[index] !== undefined)
        return values[index];

    return fallback;
}

function _getProfiles() {
    let names = settings.get_strv(PROFILE_KEYS.names);
    let commands = settings.get_strv(PROFILE_KEYS.commands);
    let workdirs = settings.get_strv(PROFILE_KEYS.workdirs);
    let patterns = settings.get_strv(PROFILE_KEYS.patterns);
    let length = Math.max(names.length, commands.length, workdirs.length, patterns.length);
    let profiles = [];

    for (let i = 0; i < length; i++) {
        profiles.push({
            name: _valueAt(names, i).trim() || `Server ${i + 1}`,
            command: _valueAt(commands, i),
            workdir: _valueAt(workdirs, i),
            pattern: _valueAt(patterns, i),
        });
    }

    return profiles;
}

function _saveProfiles(profiles) {
    settings.set_strv(PROFILE_KEYS.names, profiles.map(profile => profile.name));
    settings.set_strv(PROFILE_KEYS.commands, profiles.map(profile => profile.command));
    settings.set_strv(PROFILE_KEYS.workdirs, profiles.map(profile => profile.workdir));
    settings.set_strv(PROFILE_KEYS.patterns, profiles.map(profile => profile.pattern));

    let selected = settings.get_int(PROFILE_KEYS.selected);
    if (profiles.length === 0 && selected !== 0)
        settings.set_int(PROFILE_KEYS.selected, 0);
    else if (profiles.length > 0 && selected >= profiles.length)
        settings.set_int(PROFILE_KEYS.selected, profiles.length - 1);

    _refreshSelectedServerCombo();
}

function _addProfile() {
    let profiles = _getProfiles();

    profiles.push({
        name: `Server ${profiles.length + 1}`,
        command: '',
        workdir: '',
        pattern: '',
    });

    _saveProfiles(profiles);
    settings.set_int(PROFILE_KEYS.selected, profiles.length - 1);
    _renderProfiles();
}

function _removeProfile(index) {
    let profiles = _getProfiles();

    profiles.splice(index, 1);
    _saveProfiles(profiles);
    _renderProfiles();
}

function _updateProfile(index, field, value) {
    let profiles = _getProfiles();
    if (index >= profiles.length)
        return;

    profiles[index][field] = value;
    _saveProfiles(profiles);
}

function _buildSelectedServerRow() {
    let row = new Adw.ActionRow({
        title: 'Selected server',
        subtitle: 'The profile used by the panel menu Start button.',
    });
    let model = new Gtk.ListStore();
    model.set_column_types([GObject.TYPE_INT, GObject.TYPE_STRING]);

    selectedServerCombo = new Gtk.ComboBox({
        model,
        valign: Gtk.Align.CENTER,
    });

    let renderer = new Gtk.CellRendererText();
    selectedServerCombo.pack_start(renderer, true);
    selectedServerCombo.add_attribute(renderer, 'text', 1);
    selectedServerCombo.connect('changed', () => {
        if (updatingUi)
            return;

        let [success, iter] = selectedServerCombo.get_active_iter();
        if (success)
            settings.set_int(PROFILE_KEYS.selected, model.get_value(iter, 0));
    });

    row.add_suffix(selectedServerCombo);
    row.activatable_widget = selectedServerCombo;
    _refreshSelectedServerCombo();

    return row;
}

function _refreshSelectedServerCombo() {
    if (!selectedServerCombo)
        return;

    updatingUi = true;

    let model = selectedServerCombo.get_model();
    let profiles = _getProfiles();
    let selected = settings.get_int(PROFILE_KEYS.selected);

    model.clear();
    for (let i = 0; i < profiles.length; i++)
        model.set(model.append(), [0, 1], [i, profiles[i].name]);

    selectedServerCombo.set_sensitive(profiles.length > 0);
    selectedServerCombo.set_active(profiles.length === 0 ? -1 : Math.min(selected, profiles.length - 1));

    updatingUi = false;
}

function _renderProfiles() {
    if (!profileListBox)
        return;

    let child = profileListBox.get_first_child();
    while (child) {
        let next = child.get_next_sibling();
        profileListBox.remove(child);
        child = next;
    }

    let profiles = _getProfiles();
    _refreshSelectedServerCombo();

    if (profiles.length === 0) {
        profileListBox.append(new Gtk.Label({
            label: 'No server profiles configured.',
            xalign: 0,
        }));
        return;
    }

    for (let i = 0; i < profiles.length; i++)
        profileListBox.append(_buildProfileEditor(i, profiles[i]));
}

function _buildProfileEditor(index, profile) {
    let frame = new Gtk.Frame();
    let grid = new Gtk.Grid({
        column_spacing: 12,
        row_spacing: 8,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    let heading = new Gtk.Label({
        label: `Server ${index + 1}`,
        xalign: 0,
        hexpand: true,
    });
    let removeButton = new Gtk.Button({
        label: 'Remove',
        valign: Gtk.Align.CENTER,
    });

    removeButton.connect('clicked', () => _removeProfile(index));
    grid.attach(heading, 0, 0, 1, 1);
    grid.attach(removeButton, 1, 0, 1, 1);
    _attachProfileEntry(grid, 1, 'Name', profile.name, text => {
        _updateProfile(index, 'name', text);
        _refreshSelectedServerCombo();
    });
    _attachProfileEntry(grid, 2, 'Command', profile.command, text => _updateProfile(index, 'command', text));
    _attachProfileEntry(grid, 3, 'Working directory', profile.workdir, text => _updateProfile(index, 'workdir', text));
    _attachProfileEntry(grid, 4, 'Process pattern', profile.pattern, text => _updateProfile(index, 'pattern', text));

    frame.set_child(grid);
    return frame;
}

function _attachProfileEntry(grid, row, labelText, value, onChanged) {
    let label = new Gtk.Label({
        label: labelText,
        xalign: 0,
    });
    let entry = new Gtk.Entry({
        text: value,
        hexpand: true,
    });

    entry.connect('changed', () => onChanged(entry.get_text()));
    grid.attach(label, 0, row, 1, 1);
    grid.attach(entry, 1, row, 1, 1);
}

function _buildGeneralRow(key) {
    let config = GENERAL_SETTINGS[key];
    let row = new Adw.ActionRow({
        title: config.title,
        subtitle: config.subtitle,
    });

    if (config.type === 'string') {
        let entry = new Gtk.Entry({
            text: settings.get_string(key),
            valign: Gtk.Align.CENTER,
            width_chars: 38,
        });

        entry.connect('changed', () => settings.set_string(key, entry.get_text()));
        row.add_suffix(entry);
        row.activatable_widget = entry;
    } else if (config.type === 'int') {
        let spin = Gtk.SpinButton.new_with_range(config.min, config.max, 1);

        spin.set_value(settings.get_int(key));
        spin.set_valign(Gtk.Align.CENTER);
        spin.connect('value-changed', () => settings.set_int(key, spin.get_value_as_int()));
        row.add_suffix(spin);
        row.activatable_widget = spin;
    } else if (config.type === 'combo') {
        let model = new Gtk.ListStore();
        model.set_column_types([GObject.TYPE_INT, GObject.TYPE_STRING]);

        for (let i = 0; i < config.options.length; i++)
            model.set(model.append(), [0, 1], [i, config.options[i]]);

        let combo = new Gtk.ComboBox({model, valign: Gtk.Align.CENTER});
        let renderer = new Gtk.CellRendererText();

        combo.pack_start(renderer, true);
        combo.add_attribute(renderer, 'text', 1);
        combo.set_active(settings.get_int(key));
        combo.connect('changed', () => {
            let [success, iter] = combo.get_active_iter();
            if (success)
                settings.set_int(key, model.get_value(iter, 0));
        });
        row.add_suffix(combo);
        row.activatable_widget = combo;
    }

    return row;
}

function _buildSwitchRow(key) {
    let config = PANEL_SETTINGS[key];
    let row = new Adw.ActionRow({
        title: config.title,
        subtitle: config.subtitle,
    });
    let toggle = new Gtk.Switch({
        active: settings.get_boolean(key),
        valign: Gtk.Align.CENTER,
    });

    settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(toggle);
    row.activatable_widget = toggle;

    return row;
}
