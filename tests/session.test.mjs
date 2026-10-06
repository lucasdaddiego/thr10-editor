// Connection state machine (session.js) driven with a fake clock, plus the
// THR port pick from midi.js. These are the rules that used to be verified
// only with the amp plugged in.
import { Session, DUMP_DEBOUNCE_MS, DUMP_TIMEOUT_MS, ANNOUNCE_QUIET_MS } from '../public/js/session.js';
import { pickThrPort } from '../public/js/midi.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${label}`);
};

// Fake clock: timers fire when `advance` crosses their due time.
function harness({ attachOk = true, patchOk = true } = {}) {
  let t = 0;
  const timers = [];
  const log = { attaches: 0, patches: [], errors: [] };
  const session = new Session({
    now: () => t,
    schedule: (fn, ms) => timers.push({ at: t + ms, fn }),
    sendAttach: () => { if (attachOk) log.attaches++; return attachOk; },
    sendPatch: why => { if (patchOk) log.patches.push(why); return patchOk; },
    onError: text => log.errors.push(text),
  });
  const advance = ms => {
    t += ms;
    for (const timer of timers.splice(0)) {
      if (timer.at <= t) timer.fn(); else timers.push(timer);
    }
  };
  return { session, log, advance };
}

// --- a dump request while offline does nothing
{
  const { session, log } = harness();
  check('offline: requestDump sends nothing', session.requestDump(), false);
  check('offline: no attach went out', log.attaches, 0);
}

// --- connect with nothing pending asks for a dump; a second ask within the
//     debounce window is dropped, one after it goes out
{
  const { session, log, advance } = harness();
  session.connection(true);
  check('connect asks for a dump', log.attaches, 1);
  check('ask inside the debounce window is dropped', session.requestDump(), false);
  advance(DUMP_DEBOUNCE_MS);
  check('ask after the debounce window goes out', session.requestDump(), true);
  check('two attaches in total', log.attaches, 2);
}

// --- no dump within the timeout: one error; a dump in time: silence
{
  const { session, log, advance } = harness();
  session.connection(true);
  advance(DUMP_TIMEOUT_MS);
  check('silent amp: error after the timeout', log.errors.length, 1);
  check('silent amp: error text names the USB link', /USB/.test(log.errors[0]), true);
}
{
  const { session, log, advance } = harness();
  session.connection(true);
  advance(100);
  session.dumpReceived();
  advance(DUMP_TIMEOUT_MS);
  check('dump in time: no error', log.errors, []);
}
{
  const { session, log, advance } = harness();
  session.connection(true);
  session.connection(false);
  advance(DUMP_TIMEOUT_MS);
  check('port lost before the timeout: no error', log.errors, []);
}

// --- a failed attach send schedules no timeout
{
  const { session, log, advance } = harness({ attachOk: false });
  session.connection(true);
  advance(DUMP_TIMEOUT_MS);
  check('failed attach: no timeout error', log.errors, []);
  check('failed attach: nothing counted as sent', log.attaches, 0);
}

// --- a patch loaded offline is written on connect instead of fetching the amp
{
  const { session, log } = harness();
  session.deferSend('library slot 7');
  const why = session.connection(true);
  check('pending patch is sent on connect', log.patches, ['library slot 7, sent on connect']);
  check('connection() reports what it wrote', why, 'library slot 7, sent on connect');
  check('pending patch: no dump request', log.attaches, 0);
  check('pending cleared after the send', session.pendingSend, null);
}
{
  const { session, log } = harness({ patchOk: false });
  session.deferSend('YDP import');
  check('failed send reports nothing written', session.connection(true), null);
  check('failed send keeps the patch pending', session.pendingSend, 'YDP import');
  check('failed send: no dump request either', log.attaches, 0);
}

// --- announce handling: trailing announces are ignored, fresh ones ask
{
  const { session, log, advance } = harness();
  session.connection(true);           // attach #1
  advance(100);
  session.dumpReceived();
  advance(50);
  session.announce();                 // trails the dump
  check('announce right after a dump asks nothing', log.attaches, 1);
  advance(ANNOUNCE_QUIET_MS + 1);
  session.announce();                 // a real (re)announce
  check('announce after the quiet window asks again', log.attaches, 2);
}
{
  const { session, log, advance } = harness();
  session.deferSend('library slot 1');
  session.connection(true);           // writes the patch, no attach
  advance(300);
  session.announce();                 // trails the connect-time send
  check('announce right after a connect send asks nothing', log.attaches, 0);
  advance(ANNOUNCE_QUIET_MS);
  session.announce();
  check('announce later asks for a dump', log.attaches, 1);
}
{
  const { session, log } = harness();
  session.announce();
  check('announce while offline asks nothing', log.attaches, 0);
}

// --- disconnect then reconnect without anything pending asks again
{
  const { session, log, advance } = harness();
  session.connection(true);
  advance(DUMP_DEBOUNCE_MS);
  session.connection(false);
  session.connection(true);
  check('reconnect asks for a dump', log.attaches, 2);
}

// --- port pick (midi.js): first connected port whose name mentions THR
{
  const ports = [
    { name: 'IAC Driver Bus 1', state: 'connected' },
    { name: 'THR10', state: 'disconnected' },
    { name: 'Yamaha thr10 Port', state: 'connected' },
    { name: 'THR10C', state: 'connected' },
  ];
  check('pickThrPort skips non-THR and disconnected ports', pickThrPort(ports)?.name, 'Yamaha thr10 Port');
  check('pickThrPort with no THR port', pickThrPort([{ name: 'Other', state: 'connected' }]), null);
  check('pickThrPort tolerates an unnamed port', pickThrPort([{ name: null, state: 'connected' }]), null);
  check('pickThrPort accepts an iterator', pickThrPort(new Map([['a', ports[3]]]).values())?.name, 'THR10C');
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
