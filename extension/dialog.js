// SPDX-License-Identifier: GPL-2.0-or-later
//
// The authentication dialog. Based on gnome-shell's
// js/ui/components/polkitAgent.js (GPL-2.0-or-later), with one difference: when the fingerprint reader is part of the PAM stack it
// runs two authentication sessions for the same request. The first one holds
// the reader. The second finds the reader busy, so PAM moves straight on to
// the password. Whichever succeeds first answers the request.

import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PolkitAgent from 'gi://PolkitAgent';
import Polkit from 'gi://Polkit';
import St from 'gi://St';
import Gettext from 'gettext';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';
import {wiggle} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {hasEnrolledFinger} from './fprintd.js';
import {FingerGlyph} from './glyph.js';
import {classify} from './model.js';
import {readStatus} from './pam.js';

// Strings the shell already translates.
const shell_ = Gettext.domain('gnome-shell').gettext;
const fprintd_ = Gettext.domain('fprintd').gettext;

// Our own value: the shell moved its own around between releases.
const AVATAR_SIZE = 96;

const TICK_MS = 50;
// How long a "not recognised" stays on screen before the reader is shown as
// waiting again.
const FAIL_HOLD_MS = 900;
// The reader gives up after its PAM timeout. It is started again this many
// times while the dialog stays open, then left alone.
const MAX_REARMS = 5;
const SUCCESS_HOLD_MS = 450;
// When something else holds the reader (often the helper of a dialog that was
// just cancelled, which keeps it until its PAM timeout), try again this often.
const RETRY_MS = 1500;
const EXHAUST_GRACE_MS = 400;
const MAX_RESTARTS = 3;

export const FingerDialog = GObject.registerClass({
    Signals: {'done': {param_types: [GObject.TYPE_BOOLEAN]}},
}, class FingerDialog extends ModalDialog.ModalDialog {
    _init(actionId, description, cookie, userNames, settings) {
        super._init({styleClass: 'prompt-dialog'});

        this._settings = settings;

        this.actionId = actionId;

        this.connect('closed', this._onDialogClosed.bind(this));

        this.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: shell_('Authentication Required'),
            description,
        }));

        const body = new Dialog.MessageDialogContent();

        let userName = GLib.get_user_name();
        if (!userNames.includes(userName))
            userName = 'root';
        if (!userNames.includes(userName))
            userName = userNames[0];

        this._user = AccountsService.UserManager.get_default().get_user(userName);

        const userBox = new St.BoxLayout({
            style_class: 'polkit-dialog-user-layout',
            orientation: Clutter.Orientation.VERTICAL,
        });
        body.add_child(userBox);

        this._userAvatar = new UserWidget.Avatar(this._user, {
            iconSize: AVATAR_SIZE,
        });
        this._userAvatar.x_align = Clutter.ActorAlign.CENTER;
        userBox.add_child(this._userAvatar);

        this._userLabel = new St.Label({
            style_class: userName === 'root'
                ? 'polkit-dialog-user-root-label'
                : 'polkit-dialog-user-label',
        });
        if (userName === 'root')
            this._userLabel.text = shell_('Administrator');
        userBox.add_child(this._userLabel);

        // Fingerprint reader: glyph, one line of status, attempts left
        this._sensorBox = new St.BoxLayout({
            style_class: 'finger-pass-sensor',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this._glyph = new FingerGlyph();
        this._sensorBox.add_child(this._glyph);

        this._statusLabel = new St.Label({style_class: 'finger-pass-status'});
        this._statusLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._statusLabel.clutter_text.line_wrap = true;
        this._sensorBox.add_child(this._statusLabel);

        this._dotsBox = new St.BoxLayout({
            style_class: 'finger-pass-dots',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._sensorBox.add_child(this._dotsBox);

        this._orLabel = new St.Label({
            style_class: 'finger-pass-or',
            // Translators: shown between the fingerprint reader and the
            // password field; either of them can be used.
            text: _('or'),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._sensorBox.add_child(this._orLabel);
        body.add_child(this._sensorBox);

        // Password
        const passwordBox = new St.BoxLayout({
            style_class: 'prompt-dialog-password-layout',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._passwordEntry = new St.PasswordEntry({
            style_class: 'prompt-dialog-password-entry',
            text: '',
            can_focus: true,
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        ShellEntry.addContextMenu(this._passwordEntry);
        this._passwordEntry.clutter_text.connect('activate',
            this._onEntryActivate.bind(this));
        this._passwordEntry.bind_property('reactive',
            this._passwordEntry.clutter_text, 'editable',
            GObject.BindingFlags.SYNC_CREATE);
        passwordBox.add_child(this._passwordEntry);

        const warningBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});

        const capsLockWarning = new ShellEntry.CapsLockWarning();
        this._passwordEntry.bind_property('visible',
            capsLockWarning, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        warningBox.add_child(capsLockWarning);

        this._errorMessageLabel = new St.Label({
            style_class: 'prompt-dialog-error-label',
            visible: false,
        });
        this._errorMessageLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._errorMessageLabel.clutter_text.line_wrap = true;
        warningBox.add_child(this._errorMessageLabel);

        this._infoMessageLabel = new St.Label({
            style_class: 'prompt-dialog-info-label',
            visible: false,
        });
        this._infoMessageLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._infoMessageLabel.clutter_text.line_wrap = true;
        warningBox.add_child(this._infoMessageLabel);

        // Keeps the height steady when no message is shown, as the shell does.
        this._nullMessageLabel = new St.Label({style_class: 'prompt-dialog-null-label'});
        warningBox.add_child(this._nullMessageLabel);

        passwordBox.add_child(warningBox);
        body.add_child(passwordBox);

        // A reminder where the fingerprint would normally be: shown only when
        // a finger is enrolled and the setup is missing or needs repair.
        this._nudgeBox = new St.BoxLayout({
            style_class: 'finger-pass-nudge',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._nudgeLabel = new St.Label({
            style_class: 'finger-pass-nudge-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._nudgeButton = new St.Button({
            style_class: 'finger-pass-link',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._nudgeButton.connect('clicked', () => {
            Extension.lookupByUUID('finger-pass@griffit.gmail.com')?.openPreferences();
            this._nudgeBox.hide();
        });
        this._nudgeBox.add_child(this._nudgeLabel);
        this._nudgeBox.add_child(this._nudgeButton);
        body.add_child(this._nudgeBox);

        this._cancelButton = this.addButton({
            label: shell_('Cancel'),
            action: this.cancel.bind(this),
            key: Clutter.KEY_Escape,
        });
        this._okButton = this.addButton({
            label: shell_('Authenticate'),
            action: this._onAuthenticateButtonPressed.bind(this),
            reactive: false,
        });
        this._okButton.bind_property('reactive',
            this._okButton, 'can-focus',
            GObject.BindingFlags.SYNC_CREATE);

        this._passwordEntry.clutter_text.connect('text-changed', text => {
            this._okButton.reactive = this._keyboardReady && text.get_text().length > 0;
        });

        this.contentLayout.add_child(body);

        this._identityToAuth = Polkit.UnixUser.new_for_name(userName);
        this._cookie = cookie;

        this._doneEmitted = false;
        this._closed = false;
        this._confirmMode = false;
        this._started = false;

        this._sessions = new Set();
        this._sensor = null;
        this._keyboard = null;
        this._spare = null;
        this._keyboardReady = false;

        this._fingerprint = false;
        this._maxTries = 3;
        this._timeout = 30;
        this._fails = 0;
        this._rearms = 0;
        this._tickId = 0;
        this._failHoldId = 0;
        this._successId = 0;
        this._pendingPrompt = false;
        this._retryId = 0;
        this._exhaustId = 0;
        this._restarts = 0;
        this._retryUntil = null;
        this._enrolled = false;

        this._user.connectObject(
            'notify::is-loaded', this._onUserChanged.bind(this),
            'changed', this._onUserChanged.bind(this), this);

        this._loadSetup().catch(logError);
    }

    async _loadSetup() {
        const [{polkit, installed, stale}, enrolled] =
            await Promise.all([readStatus(), hasEnrolledFinger()]);
        if (this._closed)
            return;

        this._enrolled = enrolled;
        this._maybeNudge(polkit, installed, stale, enrolled);

        this._fingerprint = polkit.state !== 'none';
        this._maxTries = polkit.maxTries;
        this._timeout = polkit.timeout;

        for (let i = 0; i < this._maxTries; i++)
            this._dotsBox.add_child(new St.Widget({style_class: 'finger-pass-dot'}));

        this._started = true;
        this._onUserChanged();
    }

    _maybeNudge(polkit, installed, stale, enrolled) {
        const missing = polkit.state === 'none';
        const outOfDate = polkit.state === 'ours' && stale;

        if (!enrolled || !(missing || outOfDate) || !this._settings?.get_boolean('show-nudge'))
            return;

        const repair = installed || outOfDate;
        this._nudgeLabel.text = repair
            ? _('The fingerprint setup needs repair.')
            : _('Your fingerprint is not used here yet.');
        this._nudgeButton.label = repair ? _('Repair') : _('Set up');
        this._nudgeBox.show();
    }

    _onUserChanged() {
        if (!this._started || !this._user?.is_loaded)
            return;

        const userName = this._user.get_user_name();
        if (userName !== 'root')
            this._userLabel.set_text(this._user.get_real_name());
        this._userAvatar.update();

        const noPassword =
            this._user.get_password_mode() === AccountsService.UserPasswordMode.NONE;

        if (noPassword && !this._confirmMode) {
            // Starting a session would authenticate straight away, so wait
            // for the button instead.
            this._confirmMode = true;
            this._dropAllSessions();
            this._okButton.reactive = true;
            this._ensureOpen();
        } else if (!noPassword && this._sessions.size === 0) {
            this._confirmMode = false;
            this._startSession('probe');
        }
    }

    // role says what the session was started for:
    //   probe    - first session, we do not know yet what PAM will ask
    //   sensor   - expected to take the fingerprint reader
    //   keyboard - expected to ask for the password
    _startSession(role) {
        const entry = {
            role,
            done: false,
            session: new PolkitAgent.Session({
                identity: this._identityToAuth,
                cookie: this._cookie,
            }),
        };

        entry.session.connectObject(
            'completed', (_s, gained) => this._onCompleted(entry, gained),
            'request', (_s, request, echoOn) => this._onRequest(entry, request, echoOn),
            'show-error', (_s, text) => this._onMessage(entry, text, true),
            'show-info', (_s, text) => this._onMessage(entry, text, false), this);

        this._sessions.add(entry);
        if (role === 'sensor')
            this._sensor = entry;
        else if (role === 'keyboard')
            this._keyboard = entry;

        entry.session.initiate();
        return entry;
    }

    _dropSession(entry) {
        if (!entry || !this._sessions.delete(entry))
            return;

        entry.session.disconnectObject(this);
        if (!entry.done)
            entry.session.cancel();

        if (this._sensor === entry)
            this._sensor = null;
        if (this._keyboard === entry)
            this._keyboard = null;
        if (this._spare === entry)
            this._spare = null;
    }

    _dropAllSessions() {
        for (const entry of [...this._sessions])
            this._dropSession(entry);
        this._keyboardReady = false;
    }

    _onMessage(entry, text, isError) {
        // A first message instead of a password request means this session
        // got the reader.
        if (entry.role === 'probe' && this._fingerprint) {
            entry.role = 'sensor';
            this._sensor = entry;
        }

        if (entry === this._sensor) {
            if (!entry.armed) {
                entry.armed = true;
                this._onSensorArmed();
            }
            this._showSensorMessage(text, isError);
        } else if (entry !== this._spare) {
            this._showKeyboardMessage(text, isError);
        }

        this._ensureOpen();
    }

    _onRequest(entry, request, echoOn) {
        entry.request = request;
        entry.echoOn = echoOn;

        if (entry === this._sensor) {
            // The fingerprint stage of this session is over: it timed out,
            // ran out of attempts, or never got the reader.
            this._onSensorStageEnded(entry);
            return;
        }

        if (entry.role === 'probe') {
            entry.role = 'keyboard';
            this._keyboard = entry;

            // The reader should have answered first. It may only be busy.
            if (this._fingerprint && this._enrolled)
                this._scheduleRetry();
        }

        if (entry === this._keyboard)
            this._showPasswordEntry(entry);
    }

    _onCompleted(entry, gained) {
        entry.done = true;

        if (this._doneEmitted || this._successId)
            return;

        if (gained) {
            if (entry !== this._sensor) {
                this._emitDone(false);
                return;
            }

            // Leave the green fingerprint on screen for a moment.
            this._glyph.setState('success');
            this._statusLabel.text = _('Fingerprint recognised');
            this._successId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUCCESS_HOLD_MS, () => {
                this._successId = 0;
                this._emitDone(false);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (entry === this._sensor) {
            this._dropSession(entry);
            this._sensorOff();
            return;
        }

        if (entry !== this._keyboard) {
            const wasProbe = entry.role === 'probe';
            this._dropSession(entry);

            // A first session that ends without asking for anything: start
            // over, as the shell does, but not for ever.
            if (wasProbe && this._restarts++ < MAX_RESTARTS)
                this._startSession('probe');
            else if (wasProbe)
                this._emitDone(true);
            return;
        }

        // Wrong password
        if (!this._errorMessageLabel.visible) {
            this._errorMessageLabel.set_text(
                shell_('Sorry, that didn’t work. Please try again.'));
            this._errorMessageLabel.show();
            this._infoMessageLabel.hide();
            this._nullMessageLabel.hide();
            wiggle(this._passwordEntry);
        }

        this._dropSession(entry);
        this._keyboardReady = false;

        if (this._spare) {
            // A session already waiting at its password prompt.
            const spare = this._spare;
            this._spare = null;
            spare.role = 'keyboard';
            this._keyboard = spare;
            this._showPasswordEntry(spare);
        } else {
            // With the reader held by the sensor session this one goes
            // straight to the password. Otherwise it starts over like the
            // first one did.
            this._startSession(this._sensor ? 'keyboard' : 'probe');
        }
    }

    _onSensorArmed() {
        this._sensorBox.show();
        this._orLabel.show();
        this._glyph.setState('waiting');

        if (!this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                this._glyph.advance(TICK_MS / 1000);
                return GLib.SOURCE_CONTINUE;
            });
        }

        // The password field is offered at the same time.
        if (!this._keyboard && !this._spare)
            this._startSession('keyboard');
    }

    _showSensorMessage(text, isError) {
        switch (classify(text, isError, fprintd_)) {
        case 'no-match':
            this._fails++;
            this._dotsBox.get_children().forEach((dot, i) => {
                if (i < this._fails)
                    dot.add_style_class_name('used');
            });
            this._glyph.setState('fail');
            this._statusLabel.text = _('Fingerprint not recognised');
            wiggle(this._glyph);
            this._holdFailure();
            if (this._fails >= this._maxTries)
                this._endSensorSoon();
            break;
        case 'timed-out':
            break;
        case 'retry':
            // Too short, not centred and the like: fprintd's own wording,
            // in the user's language when fprintd has it.
            this._glyph.setState('retry');
            this._statusLabel.text = fprintd_(text);
            break;
        default:
            // pam_fprintd asks again right after a failure; let the failure
            // stay readable first.
            // The prompt itself names the reader or the finger in ways
            // that vary from one machine to the next; ours is shorter.
            if (this._failHoldId) {
                this._pendingPrompt = true;
            } else {
                this._glyph.setState('waiting');
                this._statusLabel.text = _('Touch the fingerprint reader');
            }
        }
    }

    // Attempts are counted over the whole dialog, PAM counts them per
    // session. When ours run out first, give PAM a moment to end the session
    // by itself (it then stays usable for the password), then end it here.
    _endSensorSoon() {
        if (this._exhaustId)
            return;

        this._exhaustId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EXHAUST_GRACE_MS, () => {
            this._exhaustId = 0;
            if (this._sensor) {
                this._dropSession(this._sensor);
                this._sensorOff(true);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _holdFailure() {
        if (this._failHoldId)
            GLib.source_remove(this._failHoldId);

        this._failHoldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FAIL_HOLD_MS, () => {
            this._failHoldId = 0;
            if (this._sensor && this._glyph.state === 'fail') {
                this._glyph.setState('waiting');
                if (this._pendingPrompt)
                    this._statusLabel.text = _('Touch the fingerprint reader');
            }
            this._pendingPrompt = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSensorStageEnded(entry) {
        const exhausted = this._fails >= this._maxTries;
        this._sensor = null;

        if (entry.armed && !exhausted && this._rearms < MAX_REARMS) {
            // Timed out: start the reader again.
            this._dropSession(entry);
            this._rearms++;
            this._startSession('sensor');
            return;
        }

        // The session now sits at its own password prompt. Keep it around:
        // it takes over if the password typed in the other one is wrong.
        if (!this._keyboard) {
            entry.role = 'keyboard';
            this._keyboard = entry;
            this._showPasswordEntry(entry);
        } else if (!this._spare) {
            entry.role = 'spare';
            this._spare = entry;
        } else {
            this._dropSession(entry);
        }

        this._sensorOff(exhausted);
        if (!entry.armed)
            this._scheduleRetry();
    }

    _scheduleRetry() {
        if (this._retryId || this._closed || this._doneEmitted)
            return;

        // No point going on once any earlier helper has timed out.
        const now = GLib.get_monotonic_time();
        this._retryUntil ??= now + (this._timeout + 2) * 1e6;
        if (now > this._retryUntil)
            return;

        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
            this._retryId = 0;
            if (!this._sensor && !this._doneEmitted)
                this._startSession('sensor');
            return GLib.SOURCE_REMOVE;
        });
    }

    _sensorOff(exhausted = false) {
        if (!this._sensorBox.visible)
            return;

        this._glyph.setState('off');
        this._stopTick();
        this._statusLabel.text = exhausted
            ? _('Too many attempts. Type your password.')
            : _('Fingerprint reader paused. Type your password.');
        this._orLabel.hide();
    }

    _stopTick() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }

    _showPasswordEntry(entry) {
        const request = entry.request ?? 'Password:';

        // The request comes straight from PAM; use the shell's translation
        // for the usual one, as the shell does.
        if (request === 'Password:' || request === 'Password: ')
            this._passwordEntry.hint_text = shell_('Password');
        else
            this._passwordEntry.hint_text = request.replace(/: *$/, '').trim();

        this._passwordEntry.password_visible = !!entry.echoOn;
        this._passwordEntry.show();
        this._passwordEntry.set_text('');
        this._passwordEntry.reactive = true;
        this._keyboardReady = true;
        this._okButton.reactive = false;

        this._ensureOpen();
        this._passwordEntry.grab_key_focus();
    }

    _showKeyboardMessage(text, isError) {
        const [shown, hidden] = isError
            ? [this._errorMessageLabel, this._infoMessageLabel]
            : [this._infoMessageLabel, this._errorMessageLabel];

        shown.set_text(text);
        shown.show();
        hidden.hide();
        this._nullMessageLabel.hide();
    }

    _onEntryActivate() {
        const response = this._passwordEntry.get_text();
        if (response.length === 0 || !this._keyboardReady || !this._keyboard)
            return;

        this._keyboardReady = false;
        this._passwordEntry.reactive = false;
        this._okButton.reactive = false;

        this._keyboard.session.response(response);

        this._errorMessageLabel.hide();
        this._infoMessageLabel.hide();
        this._nullMessageLabel.show();
    }

    _onAuthenticateButtonPressed() {
        if (this._confirmMode) {
            this._okButton.reactive = false;
            this._startSession('probe');
        } else
            this._onEntryActivate();
    }

    _ensureOpen() {
        if (this._closed || this.open())
            return;

        // Same as the shell: without the input grab there is no dialog, so
        // the request is dismissed.
        console.warn(`Finger Pass: could not show the dialog for ${this.actionId}`);
        this._emitDone(true);
    }

    _emitDone(dismissed) {
        if (this._doneEmitted)
            return;

        this._doneEmitted = true;
        this.emit('done', dismissed);
    }

    cancel() {
        // Too late to cancel once the fingerprint has been accepted.
        if (!this._successId)
            this._emitDone(true);
    }

    close(timestamp) {
        // Stop everything now rather than when the fade-out ends.
        this._onDialogClosed();

        // A dialog that was never opened is not destroyed by ModalDialog.
        if (this.state === ModalDialog.State.CLOSED) {
            this.destroy();
            return;
        }

        super.close(timestamp);
    }

    _onDialogClosed() {
        if (this._closed)
            return;
        this._closed = true;

        this._stopTick();

        if (this._exhaustId)
            GLib.source_remove(this._exhaustId);
        this._exhaustId = 0;

        if (this._failHoldId)
            GLib.source_remove(this._failHoldId);
        this._failHoldId = 0;

        if (this._successId)
            GLib.source_remove(this._successId);
        this._successId = 0;

        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;

        this._user?.disconnectObject(this);
        this._user = null;

        this._dropAllSessions();
    }
});
