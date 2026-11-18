// SPDX-License-Identifier: GPL-2.0-or-later
//
// Reads the PAM setup and changes it. Reading needs no privilege. Changing
// goes through pkexec and /bin/sh with the fixed scripts below: nothing that
// runs as root is a file a user process could edit.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {HINT_FILE, MARK, pamLines, serviceStatus} from './model.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const SUDO = '/etc/pam.d/sudo';
const POLKIT = '/etc/pam.d/polkit-1';
const POLKIT_VENDOR = '/usr/lib/pam.d/polkit-1';
const COMMON = '/etc/pam.d/common-auth';

// Quotes a string for /bin/sh. The scripts below are constants; the only
// thing woven into them is the hint, which is translated text.
function quote(text) {
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

// Puts our lines right before common-auth in the two services, replacing a
// setup of ours that is already there (an older one, for instance). A
// service that mentions pam_fprintd without our mark is left alone. The
// polkit file only exists under /usr/lib on a stock system, so it is copied
// to /etc first, with a first line saying where it came from.
function enableScript(hint) {
    const text = hint.replace(/[%\n]/g, ' ');
    const sudoLines = pamLines('sudo').join('\\n');
    const polkitLines = pamLines('polkit').join('\\n');

    return `set -eu
backup=/var/backups/${MARK}
tmp=
trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT

# Whether to leave a file alone: fprintd set up by something else.
foreign() {
    grep -q 'pam_fprintd\\.so' "$1" && ! grep -q '# ${MARK}$' "$1"
}

# Check everything before writing anything.
polkit=${POLKIT}
[ -e "$polkit" ] || polkit=${POLKIT_VENDOR}
for f in ${SUDO} "$polkit"; do
    if ! foreign "$f" && ! grep -q '^@include common-auth' "$f"; then
        echo "$f does not include common-auth; this layout is not supported" >&2
        exit 1
    fi
done

mkdir -p "$backup"

put() {
    f="$1"
    lines="$2"
    foreign "$f" && return 0
    # The backup is the file as it was before us, without our lines.
    [ -e "$backup/$(basename "$f")" ] || grep -v '# ${MARK}$' "$f" > "$backup/$(basename "$f")"
    tmp=$(mktemp "$f.XXXXXX")
    grep -v '# ${MARK}$' "$f" | awk -v l="$lines" '!done && /^@include common-auth/ { print l; done = 1 } { print }' > "$tmp"
    grep -q 'pam_fprintd\\.so' "$tmp"
    chown root:root "$tmp"
    chmod 644 "$tmp"
    mv "$tmp" "$f"
    tmp=
}

if [ ! -e ${POLKIT} ]; then
    tmp=$(mktemp ${POLKIT}.XXXXXX)
    { echo '# copied from ${POLKIT_VENDOR} by ${MARK}'; cat ${POLKIT_VENDOR}; } > "$tmp"
    chown root:root "$tmp"
    chmod 644 "$tmp"
    mv "$tmp" ${POLKIT}
    tmp=
fi

install -d -m 755 /etc/${MARK}
tmp=$(mktemp /etc/${MARK}/.hint.XXXXXX)
printf '%s\\n' ${quote(text)} > "$tmp"
chmod 644 "$tmp"
mv "$tmp" ${HINT_FILE}
tmp=

put ${SUDO} '${sudoLines}'
put ${POLKIT} '${polkitLines}'
`;
}

// Takes our lines out again, the hint with them, and the polkit file if we
// made it.
const DISABLE_SCRIPT = `set -eu
tmp=
trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT
for f in ${SUDO} ${POLKIT}; do
    [ -e "$f" ] || continue
    grep -q '# ${MARK}$' "$f" || continue
    tmp=$(mktemp "$f.XXXXXX")
    grep -v '# ${MARK}$' "$f" > "$tmp" || true
    chown root:root "$tmp"
    chmod 644 "$tmp"
    mv "$tmp" "$f"
    tmp=
done

if [ -e ${POLKIT} ] && head -n 1 ${POLKIT} | grep -q '^# copied from .* by ${MARK}$'; then
    rm -f ${POLKIT}
fi

rm -f ${HINT_FILE}
rmdir /etc/${MARK} 2>/dev/null || true
`;

async function read(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/**
 * @returns {Promise<{sudo: object, polkit: object}>} what each service does
 *   with the fingerprint reader, see serviceStatus() in model.js
 */
export async function readStatus() {
    const [sudo, polkitEtc, polkitVendor, common] = await Promise.all(
        [SUDO, POLKIT, POLKIT_VENDOR, COMMON].map(read));

    return {
        sudo: serviceStatus(sudo, common, 'sudo'),
        polkit: serviceStatus(polkitEtc ?? polkitVendor, common, 'polkit'),
    };
}

async function runAsRoot(script) {
    const proc = Gio.Subprocess.new(
        ['pkexec', '/bin/sh', '-c', script],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, stderr] = await proc.communicate_utf8_async(null, null);

    const status = proc.get_exit_status();
    if (status === 0)
        return;

    // pkexec: 126 is a dismissed dialog, 127 a refused authorisation.
    const dismissed = status === 126 || status === 127;
    throw new GLib.Error(Gio.IOErrorEnum,
        dismissed ? Gio.IOErrorEnum.CANCELLED : Gio.IOErrorEnum.FAILED,
        stderr.trim());
}

/**
 * @param {string} hint - the line printed before the reader is waited for in
 *   a terminal, already translated
 */
export function enable(hint) {
    return runAsRoot(enableScript(hint));
}

export function disable() {
    return runAsRoot(DISABLE_SCRIPT);
}
