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
- A reminder in the dialog (and a **Repair** button in the preferences)
  when a finger is enrolled but the setup is missing, was reset by a package
  update (`/etc/finger-pass/enabled` says it was made), or the copy of the
  polkit file has fallen behind the vendor file. A GSettings switch turns the
  reminder off.
- `extension/model.js` — plain logic, covered by `tests/model.test.js`
  (`gjs -m tests/model.test.js`).

What Turn On does, right before the first line that pulls in another stack
(`@include common-auth` on Debian and Ubuntu, `auth include system-auth` on
Fedora and Arch):
- `/etc/pam.d/sudo`, and `/etc/pam.d/sudo-i` when it has a stack of its own
  (Debian and Ubuntu; on Fedora it includes `sudo`): a hint (`pam_exec.so quiet stdout /usr/bin/cat
  /etc/finger-pass/sudo-hint`) and `pam_fprintd.so max-tries=3 timeout=5`;
- `/etc/pam.d/polkit-1` (copied from `/usr/lib/pam.d/polkit-1` if missing):
  `pam_fprintd.so max-tries=3 timeout=10`.

Every line ends with `# finger-pass`. Originals are kept, without our lines,
in `/var/backups/finger-pass/`. A file that already has pam_fprintd from
something else is left alone, and so is a service whose included stack
already has it (Fedora's `authselect enable-feature with-fingerprint`): the
setup then writes nothing, so the reader is not asked twice. Turn On over an older setup of ours updates it
(the preferences button says Update). Turn Off removes our lines, the hint
and the polkit copy. Login and the lock screen are not touched.

The hint goes through pam_exec because sudo-rs asks PAM to stay silent and
pam_echo obeys; pam_exec output reaches the terminal as a PAM message, not on
stdout, so it never ends up in a redirected command's output.

User guide with screenshots: `docs/guide.md` (French: `docs/guide.fr.md`).

## State (17 Nov 2026)

Tested in VMs with a virtual fprintd reader: Ubuntu 26.10 (GNOME Shell 51.0,
sudo-rs) and Fedora 45 (GNOME Shell 51.1, classic sudo, SELinux enforcing, 
authselect). In both: right finger, password while the reader waits, wrong
finger then right one, three wrong fingers then password, wrong password
then right one, reader timeout then finger, cancel, a dialog opened right
after a cancel, Turn On and Turn Off, extension disabled and re-enabled. On
Fedora the setup and the sudo hint were also run with SELinux enforcing: no
denial. (The virtual reader itself needs SELinux in permissive mode there.)

On a real reader (Synaptics 06cb:00bd, press type, Ubuntu 26.10): an
administrator dialog answered by finger, and sudo with one refused finger
then an accepted one.

Not done yet: a real reader on Fedora, readers from other vendors, other
shell versions, openSUSE (its polkit asks for the root password by default,
which the fingerprint does not change; not tested), lock screen and terminal
visuals, EGO submission.

Known rough edges:
- The password prompt of Turn On / Turn Off shows the raw `/bin/sh -c …`
  command; a nicer text needs a polkit action file, which an extension
  cannot install.
- A cancelled prompt keeps the reader for the rest of its PAM timeout; the
  next dialog starts with the password only and gets the reader back within
  a few seconds.
- In a terminal, sudo waits 5 seconds for the finger; Ctrl+C goes to the password. Keys typed during the wait are shown (sudo-rs #1694).
- The hint is printed even when no finger is enrolled.
- Repair is manual (one click and a password); nothing runs by itself as root, which would need a file installed outside the extension.
- On Debian and Ubuntu, `/etc/pam.d/sudo` is a package-managed file. An update that does not touch it keeps our lines. One that does can ask a question (keep or replace); run without a terminal and without `--force-confold`, `apt` or `dpkg` fails on that question. On Fedora (`%config(noreplace)`) and Arch (`.pacnew`) the modified file is kept.
- The polkit copy in `/etc/pam.d` hides the vendor file: the extension notices when it falls behind and offers Repair, which makes a fresh copy.
- Removing the extension does not remove the setup. Turn Off first, or delete the lines ending in `# finger-pass` from `/etc/pam.d/sudo`, `/etc/pam.d/sudo-i`, `/etc/pam.d/polkit-1` (and the file itself when its first line says it was copied by finger-pass) and the folder `/etc/finger-pass`.
- Locking the screen dismisses a request that is still open (the extension
  is disabled on the lock screen).
- shexli 0.2.1 reports EGO-M-004 on shell-version 51: its version table is
  out of date.
