// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {listReaders} from './fprintd.js';
import * as Pam from './pam.js';

function stateLabel({state, current}, {installed, stale}) {
    switch (state) {
    case 'ours':
        if (stale)
            return _('On, but the copy of the polkit file is out of date');
        return current ? _('On') : _('On, older setup');
    case 'other':
        return _('On, set up outside Finger Pass');
    case 'global':
        return _('On for every login service, set up outside Finger Pass');
    default:
        return installed ? _('Reset, probably by an update') : _('Off');
    }
}

export default class FingerPassPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        window.add(page);

        // Reader
        const readerGroup = new Adw.PreferencesGroup({title: _('Fingerprint reader')});
        page.add(readerGroup);

        const readerRow = new Adw.ActionRow({title: _('Looking for a reader…')});
        const settingsButton = new Gtk.Button({
            label: _('Fingerprint settings'),
            valign: Gtk.Align.CENTER,
        });
        settingsButton.connect('clicked', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'system', 'users'],
                    Gio.SubprocessFlags.NONE);
            } catch (e) {
                window.add_toast(new Adw.Toast({title: e.message}));
            }
        });
        readerRow.add_suffix(settingsButton);
        readerGroup.add(readerRow);

        // PAM
        const pamGroup = new Adw.PreferencesGroup({
            title: _('Use your fingerprint for'),
            description: _('Turning this on changes /etc/pam.d/sudo and /etc/pam.d/polkit-1, and adds a one-line hint in /etc/finger-pass. You are asked for your password once. Login and the lock screen are left as they are.'),
        });
        page.add(pamGroup);

        const polkitRow = new Adw.ActionRow({title: _('Administrator dialogs')});
        const sudoRow = new Adw.ActionRow({title: _('sudo in a terminal')});
        pamGroup.add(polkitRow);
        pamGroup.add(sudoRow);

        const actionRow = new Adw.ActionRow();
        const actionButton = new Gtk.Button({valign: Gtk.Align.CENTER});
        actionRow.add_suffix(actionButton);
        actionRow.activatable_widget = actionButton;
        pamGroup.add(actionRow);

        // Reminders
        const settings = this.getSettings();
        const remindGroup = new Adw.PreferencesGroup();
        page.add(remindGroup);
        const remindRow = new Adw.SwitchRow({
            title: _('Remind me in administrator dialogs'),
            subtitle: _('When a fingerprint is enrolled but not used there, or the setup needs repair.'),
        });
        settings.bind('show-nudge', remindRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        remindGroup.add(remindRow);

        // Notes
        const notesGroup = new Adw.PreferencesGroup({title: _('Good to know')});
        page.add(notesGroup);
        notesGroup.add(new Adw.ActionRow({
            title: _('After a restart'),
            subtitle: _('Type your password once at login. Your fingerprint works from then on.'),
        }));
        notesGroup.add(new Adw.ActionRow({
            title: _('In a terminal'),
            subtitle: _('sudo waits 5 seconds for the fingerprint. Press Ctrl+C to type your password at once.'),
        }));
        notesGroup.add(new Adw.ActionRow({
            title: _('Over SSH'),
            subtitle: _('The fingerprint is never asked for; sudo asks for the password.'),
        }));

        let turnOn = true;

        const refreshReader = async () => {
            const readers = await listReaders();

            if (readers.length === 0) {
                readerRow.title = _('No fingerprint reader found');
                readerRow.subtitle = _('Finger Pass needs a reader supported by fprintd.');
                return;
            }

            const best = readers.reduce((a, b) => b.fingers.length > a.fingers.length ? b : a);
            const count = best.fingers.length;
            readerRow.title = best.name;
            readerRow.subtitle = count === 0
                ? _('No finger enrolled yet')
                : ngettext('%d finger enrolled', '%d fingers enrolled', count).replace('%d', count);
        };

        const refreshPam = async () => {
            const {sudo, polkit, installed, stale} = await Pam.readStatus();
            polkitRow.subtitle = stateLabel(polkit, {installed, stale});
            sudoRow.subtitle = stateLabel(sudo, {installed, stale: false});

            const ours = sudo.state === 'ours' || polkit.state === 'ours';
            const foreign = !ours && (sudo.state !== 'none' || polkit.state !== 'none');
            const complete = sudo.state !== 'none' && polkit.state !== 'none';

            const outdated = (sudo.state === 'ours' && !sudo.current) ||
                (polkit.state === 'ours' && !polkit.current);

            // Set up once, and something has since taken it away or let it fall behind.
            const broken = installed && (sudo.state === 'none' || polkit.state === 'none' || stale);

            turnOn = !ours || !complete || outdated || stale;
            actionButton.label = !turnOn ? _('Turn Off')
                : broken ? _('Repair') : outdated ? _('Update') : _('Turn On');
            actionButton.css_classes = turnOn ? ['suggested-action'] : [];
            actionButton.sensitive = !(foreign && complete);
            actionRow.title = foreign && complete
                ? _('Nothing to change')
                : broken ? _('Bring the fingerprint back')
                    : outdated ? _('Bring the setup up to date')
                    : turnOn ? _('Fingerprint for both') : _('Back to password only');
        };

        actionButton.connect('clicked', async () => {
            actionButton.sensitive = false;
            try {
                await (turnOn
                    // Translators: printed in a terminal before sudo waits for
                    // the fingerprint reader.
                    ? Pam.enable(_('Touch the fingerprint reader, or press Ctrl+C to type your password.'))
                    : Pam.disable());
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    window.add_toast(new Adw.Toast({
                        title: _('Could not change the setup: %s').replace('%s', e.message),
                    }));
                }
            }
            await refreshPam().catch(logError);
        });

        refreshReader().catch(logError);
        refreshPam().catch(logError);
    }
}
