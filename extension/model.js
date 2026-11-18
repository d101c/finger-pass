// SPDX-License-Identifier: GPL-2.0-or-later
//
// Plain logic shared by the dialog and the preferences window. Nothing in
// here touches GObject, so it can be run under gjs or node for the tests.

export const MARK = 'finger-pass';

// What pam_fprintd uses when the options are left out.
const DEFAULT_MAX_TRIES = 3;
const DEFAULT_TIMEOUT = 30;

// Where the reader's answer is waited for, in seconds. In a terminal there
// is no password field to type into meanwhile, so the wait is kept short;
// the graphical dialog shows the password field at once.
export const TIMEOUT = {sudo: 5, polkit: 10};
export const MAX_TRIES = 3;
export const HINT_FILE = '/etc/finger-pass/sudo-hint';
// Left by Turn On, removed by Turn Off: tells a setup that was reset (by a
// package update, say) from one that was never made.
export const ENABLED_FILE = '/etc/finger-pass/enabled';

/**
 * The lines Turn On puts before @include common-auth in a service file.
 *
 * @param {string} kind - 'sudo' or 'polkit'
 * @returns {string[]}
 */
export function pamLines(kind) {
    const lines = [];
    if (kind === 'sudo')
        // pam_exec rather than pam_echo: sudo-rs asks PAM to stay silent, which
        // pam_echo obeys and pam_exec does not.
        lines.push(`auth    optional        pam_exec.so quiet stdout /usr/bin/cat ${HINT_FILE} # ${MARK}`);
    lines.push('auth    sufficient      pam_fprintd.so ' +
        `max-tries=${MAX_TRIES} timeout=${TIMEOUT[kind]} # ${MARK}`);
    return lines;
}

// Messages pam_fprintd sends, untranslated. The helper usually runs with the
// system locale, the shell with the user's, so both forms are compared.
export const MSG_NO_MATCH = 'Failed to match fingerprint';
export const MSG_TIMED_OUT = 'Verification timed out';

/**
 * Looks for an active pam_fprintd line in the auth stack of a PAM file.
 *
 * @param {string} text - contents of the file
 * @returns {{maxTries: number, timeout: number, ours: boolean}|null}
 */
export function findFprintd(text) {
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;

        const code = line.split('#')[0];
        if (!/^auth\s/.test(code) || !code.includes('pam_fprintd.so'))
            continue;

        const tries = /max-tries=(\d+)/.exec(code);
        const timeout = /timeout=(\d+)/.exec(code);
        return {
            maxTries: tries ? Math.max(1, parseInt(tries[1])) : DEFAULT_MAX_TRIES,
            timeout: timeout ? Math.max(1, parseInt(timeout[1])) : DEFAULT_TIMEOUT,
            ours: new RegExp(`#\\s*${MARK}\\s*$`).test(line),
        };
    }
    return null;
}

// The line our own go in front of: the first one that pulls in another
// file's stack, whatever the distribution calls it (Debian and Ubuntu
// '@include common-auth', Fedora and Arch 'auth include system-auth',
// 'auth substack ...').
export const INCLUDE_RE = '^(@include[[:space:]]+[^[:space:]]+|-?auth[[:space:]]+(include|substack)[[:space:]]+[^[:space:]]+)';

/**
 * @param {string} text - contents of a PAM file
 * @returns {string|null} the name of the file its auth stack pulls in first
 *   ('common-auth', 'system-auth'...), or null when there is none
 */
export function findInclude(text) {
    for (const raw of text.split('\n')) {
        const m = /^(?:@include\s+|-?auth\s+(?:include|substack)\s+)(\S+)/.exec(raw.trim());
        if (m)
            return m[1];
    }
    return null;
}

/**
 * Whether our copy of the vendor polkit file has fallen behind it.
 *
 * @param {string|null} etc - /etc/pam.d/polkit-1, if any
 * @param {string|null} vendor - /usr/lib/pam.d/polkit-1, if any
 * @returns {boolean} false when the copy is not ours or is up to date
 */
export function copyIsStale(etc, vendor) {
    if (etc === null || vendor === null)
        return false;

    const lines = etc.split('\n');
    if (!new RegExp(`^# copied from .* by ${MARK}$`).test(lines[0] ?? ''))
        return false;

    const ours = new RegExp(`#\\s*${MARK}\\s*$`);
    const norm = list => list.map(l => l.trimEnd()).join('\n').trimEnd();
    return norm(lines.slice(1).filter(l => !ours.test(l))) !== norm(vendor.split('\n'));
}

/**
 * @param {string} text - contents of a PAM file
 * @returns {boolean} whether it carries our hint line
 */
export function hasHint(text) {
    return text.split('\n').some(l => {
        const line = l.trim();
        return !line.startsWith('#') && line.includes('pam_exec.so') &&
            new RegExp(`#\\s*${MARK}\\s*$`).test(line);
    });
}

/**
 * Works out what a service does with the fingerprint reader.
 *
 * @param {string|null} service - contents of the service file, if any
 * @param {string|null} common - contents of the file the service includes, if any
 * @param {string} kind - 'sudo' or 'polkit'
 * @returns {{state: string, maxTries: number, timeout: number, current: boolean}}
 *   state is 'ours', 'other' (set up by something else), 'global'
 *   (inherited from common-auth) or 'none'. current tells whether a setup
 *   of ours is the one this version writes.
 */
export function serviceStatus(service, common, kind) {
    const none = {state: 'none', maxTries: DEFAULT_MAX_TRIES, timeout: DEFAULT_TIMEOUT, current: false};
    if (service === null)
        return none;

    const own = findFprintd(service);
    if (own) {
        const current = own.ours && own.maxTries === MAX_TRIES &&
            own.timeout === TIMEOUT[kind] && hasHint(service) === (kind === 'sudo');
        return {state: own.ours ? 'ours' : 'other', maxTries: own.maxTries, timeout: own.timeout, current};
    }

    const inherited = common !== null && findInclude(service) !== null
        ? findFprintd(common) : null;
    if (inherited)
        return {state: 'global', maxTries: inherited.maxTries, timeout: inherited.timeout, current: false};

    return none;
}

/**
 * Sorts a message from the fingerprint stage into what the dialog shows.
 *
 * @param {string} text - the message as received
 * @param {boolean} isError - whether PAM flagged it as an error
 * @param {Function} translate - returns the translation of a pam_fprintd message
 * @returns {string} 'no-match', 'timed-out', 'retry' or 'prompt'
 */
export function classify(text, isError, translate = s => s) {
    const same = msg => text === msg || text === translate(msg);

    if (same(MSG_NO_MATCH))
        return 'no-match';
    if (same(MSG_TIMED_OUT))
        return 'timed-out';
    return isError ? 'retry' : 'prompt';
}
