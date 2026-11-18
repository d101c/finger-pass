// SPDX-License-Identifier: GPL-2.0-or-later
//
// What fprintd knows: the readers and the fingers enrolled by the current
// user. Read-only, and allowed without privilege in a local session.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const FPRINT = 'net.reactivated.Fprint';
// The dialog waits for this before it shows up; do not let a stuck fprintd
// hold it back.
const TIMEOUT_MS = 2000;

async function call(path, iface, method, args, reply) {
    const result = await Gio.DBus.system.call(
        FPRINT, path, iface, method, args, new GLib.VariantType(reply),
        Gio.DBusCallFlags.NONE, TIMEOUT_MS, null);
    return result.recursiveUnpack();
}

/**
 * @returns {Promise<{name: string, fingers: string[]}[]>} one entry per
 *   reader; empty when fprintd is missing or has no reader
 */
export async function listReaders() {
    let paths;
    try {
        [paths] = await call('/net/reactivated/Fprint/Manager',
            `${FPRINT}.Manager`, 'GetDevices', null, '(ao)');
    } catch {
        return [];
    }

    return Promise.all(paths.map(async path => {
        let name = '';
        let fingers = [];
        try {
            [name] = await call(path, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [`${FPRINT}.Device`, 'name']), '(v)');
            [fingers] = await call(path, `${FPRINT}.Device`, 'ListEnrolledFingers',
                new GLib.Variant('(s)', ['']), '(as)');
        } catch {
            // fprintd answers with an error when nothing is enrolled.
        }
        return {name, fingers};
    }));
}

/**
 * @returns {Promise<boolean>} whether the current user has a finger enrolled
 */
export async function hasEnrolledFinger() {
    const readers = await listReaders();
    return readers.some(reader => reader.fingers.length > 0);
}
