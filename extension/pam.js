// SPDX-License-Identifier: GPL-2.0-or-later
//
// Reads the PAM setup and changes it. Reading needs no privilege. Changing
// goes through pkexec and /bin/sh with the fixed scripts below: nothing that
// runs as root is a file a user process could edit.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ENABLED_FILE, HINT_FILE, INCLUDE_RE, MARK, copyIsStale, findInclude, pamLines, serviceStatus} from './model.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const SUDO = '/etc/pam.d/sudo';
const SUDO_I = '/etc/pam.d/sudo-i';
const POLKIT = '/etc/pam.d/polkit-1';
const POLKIT_VENDOR = '/usr/lib/pam.d/polkit-1';

// Quotes a string for /bin/sh. The scripts below are constants; the only
// thing woven into them is the hint, which is translated text.
function quote(text) {
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

// Puts our lines right before the first line that pulls in another stack
// (common-auth on Debian and Ubuntu, system-auth on Fedora and Arch) in the
// two services, and in sudo-i when it has a stack of its own, replacing a
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
inc='${INCLUDE_RE}'
tmp=
trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT

# Whether to leave a file alone: fprintd set up by something else.
foreign() {
    grep -q 'pam_fprintd\\.so' "$1" && ! grep -q '# ${MARK}$' "$1"
}

# Whether the stack this file includes already has fprintd (authselect's
# with-fingerprint feature, pam-auth-update...): a line of ours would ask twice.
inherits() {
    name=$(awk -v re="$inc" '$0 ~ re { n = split($0, a, /[[:space:]]+/); print a[n]; exit }' "$1")
    [ -n "$name" ] || return 1
    for d in /etc/pam.d /usr/lib/pam.d; do
        if [ -r "$d/$name" ]; then
            grep -q 'pam_fprintd\\.so' "$d/$name"
            return
        fi
    done
    return 1
}

# Whether a service needs lines of ours: neither set up by something else nor
# covered by the stack it includes.
needs() {
    ! foreign "$1" && ! inherits "$1"
}

# Check everything before writing anything.
polkit=${POLKIT}
[ -e "$polkit" ] || polkit=${POLKIT_VENDOR}
for f in ${SUDO} "$polkit"; do
    if ! foreign "$f" && ! inherits "$f" && ! grep -Eq "$inc" "$f"; then
        echo "$f does not include another stack (common-auth, system-auth...); this layout is not supported" >&2
        exit 1
    fi
done

# sudo -i has a stack of its own on Debian and Ubuntu; on Fedora it includes sudo.
wantsudo=no
wantpolkit=no
needs ${SUDO} && wantsudo=yes
needs "$polkit" && wantpolkit=yes

sudoi=no
if [ "$wantsudo" = yes ] && [ -e ${SUDO_I} ] && needs ${SUDO_I} && grep -Eq "$inc" ${SUDO_I} \\
    && ! grep -Eq '^(@include|-?auth[[:space:]]+(include|substack))[[:space:]]+sudo[[:space:]]*$' ${SUDO_I}; then
    sudoi=yes
fi

mkdir -p "$backup"

put() {
    f="$1"
    lines="$2"
    foreign "$f" && return 0
    inherits "$f" && return 0
    # The backup is the file as it was before us, without our lines.
    [ -e "$backup/$(basename "$f")" ] || grep -v '# ${MARK}$' "$f" > "$backup/$(basename "$f")"
    tmp=$(mktemp "$f.XXXXXX")
    grep -v '# ${MARK}$' "$f" | awk -v l="$lines" -v re="$inc" '!done && $0 ~ re { print l; done = 1 } { print }' > "$tmp"
    grep -q 'pam_fprintd\\.so' "$tmp"
    chown root:root "$tmp"
    chmod 644 "$tmp"
    mv "$tmp" "$f"
    tmp=
}

# A copy of ours is made again from the vendor file, so that a vendor change
# is picked up; a polkit file of someone else is not ours to replace.
if [ "$wantpolkit" = yes ] && { [ ! -e ${POLKIT} ] || head -n 1 ${POLKIT} | grep -q '^# copied from .* by ${MARK}$'; }; then
    tmp=$(mktemp ${POLKIT}.XXXXXX)
    { echo '# copied from ${POLKIT_VENDOR} by ${MARK}'; cat ${POLKIT_VENDOR}; } > "$tmp"
    chown root:root "$tmp"
    chmod 644 "$tmp"
    mv "$tmp" ${POLKIT}
    tmp=
fi

if [ "$wantsudo" = yes ] || [ "$wantpolkit" = yes ]; then
    install -d -m 755 /etc/${MARK}
    : > ${ENABLED_FILE}
    chmod 644 ${ENABLED_FILE}
fi

if [ "$wantsudo" = yes ]; then
    tmp=$(mktemp /etc/${MARK}/.hint.XXXXXX)
    printf '%s\\n' ${quote(text)} > "$tmp"
    chmod 644 "$tmp"
    mv "$tmp" ${HINT_FILE}
    tmp=
fi

[ "$wantsudo" = no ] || put ${SUDO} '${sudoLines}'
[ "$sudoi" = no ] || put ${SUDO_I} '${sudoLines}'
[ "$wantpolkit" = no ] || put ${POLKIT} '${polkitLines}'
`;
}

// Takes our lines out again, the hint with them, and the polkit file if we
// made it.
const DISABLE_SCRIPT = `set -eu
tmp=
trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT
for f in ${SUDO} ${SUDO_I} ${POLKIT}; do
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

rm -f ${HINT_FILE} ${ENABLED_FILE}
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
    const [sudo, polkitEtc, polkitVendor, enabled, hint] = await Promise.all(
        [SUDO, POLKIT, POLKIT_VENDOR, ENABLED_FILE, HINT_FILE].map(read));
    const polkit = polkitEtc ?? polkitVendor;

    // What each service pulls in (common-auth, system-auth...), for the case
    // where fprintd is switched on there for every service.
    const included = async text => {
        const name = text === null ? null : findInclude(text);
        if (name === null)
            return null;
        return await read(`/etc/pam.d/${name}`) ?? await read(`/usr/lib/pam.d/${name}`);
    };

    return {
        sudo: serviceStatus(sudo, await included(sudo), 'sudo'),
        polkit: serviceStatus(polkit, await included(polkit), 'polkit'),
        // Turn On has been used here (the hint file is what older versions left).
        installed: enabled !== null || hint !== null,
        // Our copy of the polkit file no longer matches the vendor file.
        stale: copyIsStale(polkitEtc, polkitVendor),
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
