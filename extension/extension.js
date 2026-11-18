// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FingerDialog} from './dialog.js';

const RETRY_MS = 500;
const MAX_ATTEMPTS = 10;

// Same job as the shell's own agent, with our dialog.
const FingerAgent = GObject.registerClass(
class FingerAgent extends Shell.PolkitAuthenticationAgent {
    _init(settings) {
        super._init();

        this._settings = settings;
        this._dialog = null;

        this.connect('initiate', this._onInitiate.bind(this));
        this.connect('cancel', () => this._finish(false));
    }

    _onInitiate(_agent, actionId, message, _iconName, cookie, userNames) {
        this._dialog = new FingerDialog(actionId, message, cookie, userNames, this._settings);
        this._dialog.connect('done', (_dialog, dismissed) => this._finish(dismissed));
    }

    _finish(dismissed) {
        this._dialog?.close();
        this._dialog = null;

        this.complete(dismissed);
    }

    shutdown() {
        if (this._dialog)
            this._finish(true);

        try {
            this.unregister();
        } catch (e) {
            console.warn(`Finger Pass: ${e.message}`);
        }
    }
});

export default class FingerPassExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._attempts = 0;
        this._takeOver();
    }

    _takeOver() {
        this._retryId = 0;

        // The shell's agent is the only instance that can be asked to step
        // aside, and the component manager is the only way to reach it. It
        // is created while the session starts: asking for it any earlier
        // would make a second one, so wait for it to show up instead.
        const stock = Main.componentManager._allComponents.polkitAgent;
        let reason = 'the shell has no authentication agent yet';

        if (stock) {
            stock.disable();

            const agent = new FingerAgent(this._settings);
            try {
                agent.register();
                this._stock = stock;
                this._agent = agent;
                return;
            } catch (e) {
                reason = e.message;
                stock.enable();
            }
        }

        if (++this._attempts >= MAX_ATTEMPTS) {
            console.warn(`Finger Pass: ${reason}`);
            return;
        }

        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
            this._takeOver();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;

        // A request still on screen is dismissed here; that includes locking
        // the screen, which disables the extension.
        this._agent?.shutdown();
        this._agent = null;
        this._settings = null;

        // Hand the job back, unless the session mode has no agent at all.
        if (this._stock && Main.sessionMode.components.includes('polkitAgent'))
            this._stock.enable();
        this._stock = null;
    }
}
