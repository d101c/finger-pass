// Run with: gjs -m tests/model.test.js
import {findFprintd, findInclude, serviceStatus, classify, pamLines, hasHint, copyIsStale} from '../extension/model.js';

let failed = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) {
        failed++;
        print(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
}

const stockSudo = `#%PAM-1.0
session    required   pam_limits.so
@include common-auth
@include common-account
`;
const ourSudo = stockSudo.replace('@include common-auth', `${pamLines('sudo').join('\n')}\n@include common-auth`);
const ourPolkit = stockSudo.replace('@include common-auth', `${pamLines('polkit').join('\n')}\n@include common-auth`);
const oldSudo = stockSudo.replace('@include common-auth', 'auth    sufficient      pam_fprintd.so max-tries=3 timeout=10 # finger-pass\n@include common-auth');
const commonPlain = 'auth\t[success=1 default=ignore]\tpam_unix.so nullok\n';
const commonFprintd = `auth\t[success=2 default=ignore]\tpam_fprintd.so max-tries=1 timeout=10 # debug\n${commonPlain}`;

check('stock sudo has no fprintd', findFprintd(stockSudo), null);
check('our line is found', findFprintd(ourSudo), {maxTries: 3, timeout: 5, ours: true});
check('commented line is ignored', findFprintd('# auth sufficient pam_fprintd.so\n'), null);
check('defaults', findFprintd('auth sufficient pam_fprintd.so\n'), {maxTries: 3, timeout: 30, ours: false});
check('session line is ignored', findFprintd('session optional pam_fprintd.so\n'), null);
check('options after # are ignored', findFprintd(commonFprintd), {maxTries: 1, timeout: 10, ours: false});
check('Debian include', findInclude(stockSudo), 'common-auth');
const fedoraSudo = '#%PAM-1.0\nauth       include      system-auth\naccount    include      system-auth\nsession    required     pam_limits.so\n';
check('Fedora include', findInclude(fedoraSudo), 'system-auth');
check('substack', findInclude('auth substack password-auth\n'), 'password-auth');
check('optional include', findInclude('-auth include foo\n'), 'foo');
check('no include', findInclude('auth required pam_unix.so\n'), null);
check('account include alone is not ours to precede', findInclude('account include system-auth\n'), null);
check('Fedora status global (with-fingerprint)', serviceStatus(fedoraSudo, 'auth sufficient pam_fprintd.so\nauth sufficient pam_unix.so\n', 'sudo').state, 'global');
check('Fedora status none', serviceStatus(fedoraSudo, 'auth sufficient pam_unix.so\n', 'sudo').state, 'none');

check('status none', serviceStatus(stockSudo, commonPlain, 'sudo').state, 'none');
check('status ours sudo, current', serviceStatus(ourSudo, commonPlain, 'sudo'), {state: 'ours', maxTries: 3, timeout: 5, current: true});
check('status ours polkit, current', serviceStatus(ourPolkit, commonPlain, 'polkit'), {state: 'ours', maxTries: 3, timeout: 10, current: true});
check('older sudo setup is not current', serviceStatus(oldSudo, commonPlain, 'sudo').current, false);
check('sudo setup used for polkit is not current', serviceStatus(ourSudo, commonPlain, 'polkit').current, false);
check('hint detected', hasHint(ourSudo), true);
check('no hint in polkit', hasHint(ourPolkit), false);
check('hint line of someone else', hasHint('auth optional pam_exec.so quiet stdout /usr/bin/cat /x\n'), false);
check('status global', serviceStatus(stockSudo, commonFprintd, 'sudo'), {state: 'global', maxTries: 1, timeout: 10, current: false});
check('status other', serviceStatus('auth sufficient pam_fprintd.so\n@include common-auth\n', commonPlain, 'sudo').state, 'other');
check('missing file', serviceStatus(null, commonFprintd, 'sudo').state, 'none');

const fr = s => ({'Failed to match fingerprint': 'Empreinte non reconnue'})[s] ?? s;
check('no match (C)', classify('Failed to match fingerprint', true, fr), 'no-match');
check('no match (translated)', classify('Empreinte non reconnue', true, fr), 'no-match');
check('timed out', classify('Verification timed out', false), 'timed-out');
check('retry', classify('Finger scan was too fast, try again', true), 'retry');
check('prompt', classify('Place your right index finger on the fingerprint reader', false), 'prompt');

const vendor = '#%PAM-1.0\n\nauth include system-auth\naccount include system-auth\n';
const copy = (v, extra = '') => `# copied from /usr/lib/pam.d/polkit-1 by finger-pass\n${v.replace('auth include', `auth    sufficient      pam_fprintd.so max-tries=3 timeout=10 # finger-pass\nauth include`)}${extra}`;
check('copy up to date', copyIsStale(copy(vendor), vendor), false);
check('copy behind a vendor change', copyIsStale(copy(vendor), vendor + 'session optional pam_systemd.so\n'), true);
check('not our copy', copyIsStale(vendor, vendor + 'x\n'), false);
check('no vendor file', copyIsStale(copy(vendor), null), false);
check('trailing blanks do not count', copyIsStale(copy(vendor), vendor.replace('\n', ' \n')), false);

print(failed ? `${failed} failed` : 'all passed');
imports.system.exit(failed ? 1 : 0);
