// test-notify-all.mjs — TESTE ny route /notify-all MARINA avy ao amin'ny server.js
//
// Tsy mila Firebase, tsy mila réseau, tsy mila npm install.
// Alaina ao amin'ny server.js ilay handler, dia ampandehanina miaraka amin'ny
// `admin` sandoka — ka ny code TENA HALEFA no voatsapa, fa tsy copie.
//
// Fampandehanana :  node test-notify-all.mjs
import fs from 'fs';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ✔ ' + label); }
  else { fail++; console.log('  ✘ ' + label + '\n      got  ' + a + '\n      want ' + b); }
};

/* ── 1) Fakana ny handler marina ao amin'ny server.js ───────────────────── */
const SRC = fs.readFileSync('./server.js', 'utf8');
const START = 'app.post("/notify-all", async (req, res) => {';
const i = SRC.indexOf(START);
if (i < 0) { console.log('❌ Tsy hita ny route /notify-all ao amin\'ny server.js'); process.exit(1); }

// Mitady ny accolade mifanaraka
let depth = 0, j = i + START.length - 1, end = -1;
for (; j < SRC.length; j++) {
  const c = SRC[j];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
}
if (end < 0) { console.log('❌ Accolade tsy mifanaraka'); process.exit(1); }
const BODY = SRC.slice(i + START.length, end);
console.log('📄 Handler nalaina : ' + BODY.split('\n').length + ' andalana\n');

/* ── 2) Firebase sandoka ────────────────────────────────────────────────── */
function makeMocks({ users, callerUid, tokenValid = true, isAdmin = true, sendResult }) {
  const state = { batches: [], written: [], sentChunks: [], removed: [] };

  const docsOf = Object.entries(users).map(([id, data]) => ({ id, data: () => data }));

  const fdb = {
    doc: (p) => ({
      get: async () => {
        const uid = p.split('/')[1];
        const u = users[uid];
        return { exists: !!u, data: () => u || {} };
      },
      update: async (o) => { state.removed.push({ p, o }); },
    }),
    collection: (name) => ({
      get: async () => ({ forEach: (fn) => docsOf.forEach(fn) }),
      doc: () => ({ __new: name }),
    }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, val) => ops.push(val),
        commit: async () => { state.batches.push(ops.length); state.written.push(...ops); },
      };
    },
  };

  const admin = {
    auth: () => ({
      verifyIdToken: async () => {
        if (!tokenValid) throw new Error('bad token');
        return { uid: callerUid };
      },
    }),
    firestore: Object.assign(() => fdb, {
      FieldValue: {
        serverTimestamp: () => '__TS__',
        arrayRemove: (...a) => ({ __remove: a }),
      },
    }),
    messaging: () => ({
      sendEachForMulticast: async ({ tokens }) => {
        state.sentChunks.push(tokens.length);
        return sendResult
          ? sendResult(tokens)
          : { successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({})) };
      },
    }),
  };
  if (isAdmin && users[callerUid]) users[callerUid].isAdmin = true;
  return { admin, state };
}

async function run(opts, req) {
  const { admin, state } = makeMocks(opts);
  let code = 200, body = null;
  const res = {
    status(c) { code = c; return this; },
    json(b) { body = b; return this; },
  };
  const fn = new Function(
    'req', 'res', 'admin', 'fcmReady', 'FRONTEND_URL', 'NOTIFY_SECRET', 'console',
    'return (async () => {' + BODY + '})();'
  );
  await fn(req, res, admin, opts.fcmReady !== false, 'https://x.test', 'sekret', { log(){}, error(){} });
  return { code, body, state };
}

const mkUsers = (n, tokensPerUser = 1) => {
  const o = {};
  for (let k = 0; k < n; k++) {
    o['u' + k] = { fcmTokens: Array.from({ length: tokensPerUser }, (_, t) => `tok_${k}_${t}`) };
  }
  return o;
};

const OK_REQ = { headers: { authorization: 'Bearer xyz' }, body: { title: 'Trengo', message: 'Vaovao' } };

/* ── 3) FIAROVANA — io no tena zava-dehibe ─────────────────────────────── */
console.log('1) Fiarovana');
{
  let r = await run({ users: mkUsers(3), callerUid: 'u0' }, { headers: {}, body: OK_REQ.body });
  eq('tsy misy token → 401', r.code, 401);

  r = await run({ users: mkUsers(3), callerUid: 'u0' }, { headers: { authorization: 'xyz' }, body: OK_REQ.body });
  eq('tsy "Bearer" → 401', r.code, 401);

  r = await run({ users: mkUsers(3), callerUid: 'u0', tokenValid: false }, OK_REQ);
  eq('token diso → 401', r.code, 401);

  const users = mkUsers(3);
  users.u0.isAdmin = false;
  r = await run({ users, callerUid: 'u0', isAdmin: false }, OK_REQ);
  eq('TSY admin → 403', r.code, 403);

  r = await run({ users: mkUsers(3), callerUid: 'GHOST', isAdmin: false }, OK_REQ);
  eq('uid tsy misy ao Firestore → 403', r.code, 403);

  r = await run({ users: mkUsers(3), callerUid: 'u0' }, { headers: OK_REQ.headers, body: { title: 'x' } });
  eq('tsy misy message → 400', r.code, 400);

  r = await run({ users: mkUsers(3), callerUid: 'u0', fcmReady: false }, OK_REQ);
  eq('FCM tsy vonona → 500', r.code, 500);

  r = await run({ users: mkUsers(3), callerUid: 'u0' }, OK_REQ);
  eq('admin marina → 200', r.code, 200);
}

/* ── 4) Fan-out ────────────────────────────────────────────────────────── */
console.log('\n2) Fan-out — mpampiasa sy notification');
{
  const r = await run({ users: mkUsers(238), callerUid: 'u0' }, OK_REQ);
  eq('users = 237 (tsy anisany ny admin)', r.body.users, 237);
  eq('notification voasoratra = 237', r.body.notified, 237);
  eq('tsy mandefa amin\'ny tenany', r.state.written.some(w => w.toUid === 'u0'), false);
  eq('type = post', r.state.written[0].type, 'post');
  eq('read = false', r.state.written[0].read, false);
  eq('createdAt serverTimestamp', r.state.written[0].createdAt, '__TS__');
}

console.log('\n3) Batch Firestore — fetra 500, ampiasaina 450');
{
  let r = await run({ users: mkUsers(238), callerUid: 'u0' }, OK_REQ);
  eq('238 users → batch 1', r.state.batches, [237]);

  r = await run({ users: mkUsers(1001), callerUid: 'u0' }, OK_REQ);
  eq('1001 users → 450+450+100', r.state.batches, [450, 450, 100]);
  eq('tsy misy batch > 450', r.state.batches.every(b => b <= 450), true);
  eq('totalin\'ny batch = users', r.state.batches.reduce((a, b) => a + b, 0), 1000);
}

console.log('\n4) Multicast FCM — fetra 500 token');
{
  let r = await run({ users: mkUsers(238), callerUid: 'u0' }, OK_REQ);
  eq('237 token → antso 1', r.state.sentChunks, [237]);
  eq('sent = 237', r.body.sent, 237);

  r = await run({ users: mkUsers(600, 2), callerUid: 'u0' }, OK_REQ);
  eq('1198 token → 500+500+198', r.state.sentChunks, [500, 500, 198]);
  eq('tsy misy chunk > 500', r.state.sentChunks.every(c => c <= 500), true);
}

console.log('\n5) Token doublon sy maloto');
{
  const users = { u0: {}, u1: { fcmTokens: ['A', 'B'] }, u2: { fcmTokens: ['A', 'C'] }, u3: { fcmTokens: [] } };
  const r = await run({ users, callerUid: 'u0' }, OK_REQ);
  eq('A tsy averina indroa → 3 token', r.state.sentChunks, [3]);
  eq('users = 3 (u1,u2,u3)', r.body.users, 3);
  eq('u3 tsy misy token fa mahazo notif', r.body.notified, 3);

  const u2 = { u0: {}, u1: { fcmTokens: [null, '', 123, 'OK'] } };
  const r2 = await run({ users: u2, callerUid: 'u0' }, OK_REQ);
  eq('sanda maloto lavina → 1 token', r2.state.sentChunks, [1]);

  const u3 = { u0: {}, u1: { fcmTokens: 'tsy-array' } };
  const r3 = await run({ users: u3, callerUid: 'u0' }, OK_REQ);
  eq('fcmTokens tsy array → tsy crash', r3.code, 200);
  eq('tsy misy antso FCM', r3.state.sentChunks, []);
}

/* ── 5) Fanadiovana token maty ─────────────────────────────────────────── */
console.log('\n6) Fanadiovana ny token maty');
{
  const users = { u0: {}, u1: { fcmTokens: ['dead1'] }, u2: { fcmTokens: ['live'] } };
  const r = await run({
    users, callerUid: 'u0',
    sendResult: (toks) => ({
      successCount: toks.filter(t => t === 'live').length,
      failureCount: toks.filter(t => t !== 'live').length,
      responses: toks.map(t => t === 'live' ? {} : { error: { code: 'messaging/registration-token-not-registered' } }),
    }),
  }, OK_REQ);
  eq('cleaned = 1', r.body.cleaned, 1);
  eq('update natao amin\'ny u1', r.state.removed[0].p, 'users/u1');
  eq('arrayRemove(dead1)', r.state.removed[0].o.fcmTokens.__remove, ['dead1']);
  eq('failed = 1', r.body.failed, 1);
  eq('sent = 1', r.body.sent, 1);
}

console.log('\n7) Cas limites');
{
  const r = await run({ users: { u0: {} }, callerUid: 'u0' }, OK_REQ);
  eq('admin irery → users 0, tsy crash', r.body.users, 0);
  eq('tsy misy batch', r.state.batches, []);
  eq('tsy misy antso FCM', r.state.sentChunks, []);
  eq('code 200', r.code, 200);
}

console.log('\n─────────────────────────────');
console.log(pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
