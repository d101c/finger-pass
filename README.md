# Finger Pass

GNOME Shell extension. Administrator prompts take your fingerprint or your
password, whichever comes first, in one dialog.

- `extension/dialog.js` — the dialog. With pam_fprintd in the polkit-1 stack
  it runs two authentication sessions for the same request: the first holds
  the reader, the second finds it busy and goes straight to the password.
- `extension/extension.js` — registers our polkit agent in place of the
  shell's, and hands the job back on disable.
- `extension/prefs.js` — reader and enrolled fingers, and the Turn On / Turn
  Off button.
- `extension/pam.js` — reads the PAM setup; changes it through
  `pkexec /bin/sh -c <fixed script>` (nothing run as root is a user-writable
  file).
- `extension/fprintd.js` — readers and enrolled fingers, over D-Bus.
- `extension/model.js` — plain logic, covered by `tests/model.test.js`
  (`gjs -m tests/model.test.js`).

What Turn On does, before `@include common-auth`:
- `/etc/pam.d/sudo`: a hint (`pam_exec.so quiet stdout /usr/bin/cat
  /etc/finger-pass/sudo-hint`) and `pam_fprintd.so max-tries=3 timeout=5`;
- `/etc/pam.d/polkit-1` (copied from `/usr/lib/pam.d/polkit-1` if missing):
  `pam_fprintd.so max-tries=3 timeout=10`.

Every line ends with `# finger-pass`. Originals are kept, without our lines,
in `/var/backups/finger-pass/`. A file that already has pam_fprintd from
something else is left alone. Turn On over an older setup of ours updates it
(the preferences button says Update). Turn Off removes our lines, the hint
and the polkit copy. Login and the lock screen are not touched.

The hint goes through pam_exec because sudo-rs asks PAM to stay silent and
pam_echo obeys; pam_exec output reaches the terminal as a PAM message, not on
stdout, so it never ends up in a redirected command's output.

User guide with screenshots: `docs/guide.md` (French: `docs/guide.fr.md`).

## State (17 Nov 2026)

Tested in a VM (Ubuntu 26.10, GNOME Shell 51.0, fprintd virtual reader), with
the extension enabled after login and enabled from login: right finger,
password while the reader waits, wrong finger then right one, three wrong
fingers then password, wrong password then right one, reader timeout then
finger, cancel, a dialog opened right after a cancel, Turn Off and Turn On
from the preferences window, extension disabled and re-enabled.

On a real reader (Synaptics 06cb:00bd, press type): an administrator dialog
answered by finger, and sudo with one refused finger then an accepted one.

Not done yet: lock screen and terminal visuals, other distributions (the
setup needs `@include common-auth`, so Debian and Ubuntu; it refuses to touch
anything else), other shell versions, EGO submission.

Known rough edges:
- The password prompt of Turn On / Turn Off shows the raw `/bin/sh -c …`
  command; a nicer text needs a polkit action file, which an extension
  cannot install.
- A cancelled prompt keeps the reader for the rest of its PAM timeout; the
  next dialog starts with the password only and gets the reader back within
  a few seconds.
- In a terminal, sudo waits 5 seconds for the finger; Ctrl+C goes to the password. Keys typed during the wait are shown (sudo-rs #1694).
- The hint is printed even when no finger is enrolled.
- Locking the screen dismisses a request that is still open (the extension
  is disabled on the lock screen).
- shexli 0.2.1 reports EGO-M-004 on shell-version 51: its version table is
  out of date.
