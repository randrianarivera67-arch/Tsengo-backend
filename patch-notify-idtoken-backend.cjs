/**
 * patch-notify-idtoken-backend.cjs   —  BACKEND
 * ─────────────────────────────────────────────────────────────────────────────
 * OLANA : ny `/notify` dia miaro amin'ny `x-notify-secret`, izay avy amin'ny
 *         `VITE_NOTIFY_SECRET`. Ny prefix `VITE_` dia midika fa TAFIDITRA AO
 *         ANATY BUNDLE JAVASCRIPT PUBLIC izy — hitan'izay manokatra DevTools.
 *
 *         Vokany : na iza na iza afaka mandefa push amin'ny mpampiasa rehetra,
 *         amin'ny anaran'iza na iza — phishing, spam, fanimbana marika.
 *
 * VAHAOLANA : Firebase ID token (mitovy amin'ny nataontsika tamin'ny /notify-all).
 *         Ny serveur no manamarina amin'i Google — tsy azo foronina.
 *         Ary fantatra MARINA izay mpandefa, ka voarakitra ao amin'ny log.
 *
 * ⚠️ FIFINDRANA AN-DALANA (transition) :
 *   Ny APK efa napetraka dia mampiaka ny fichier web amin'ny OTA, ka handray ny
 *   code vaovao. FA mety hisy bundle voatahiry mandritra ny fotoana fohy.
 *   Noho izany, ity patch ity dia manaiky ny ROA :
 *     1. Authorization: Bearer <idToken>   ← vaovao, ARINDRAINA
 *     2. x-notify-secret                   ← taloha, mbola ekena, MISY LOG
 *
 *   Rehefa tsy misy intsony ny log "legacy secret" mandritra ny andro vitsivitsy
 *   dia esorina ny fanaovana faharoa (fanamarihana ao anaty code).
 *
 * FANDAHARANA TSY AZO OVAINA :
 *   1. BACKEND aloha (manaiky roa) → tsy misy tapaka
 *   2. FRONTEND avy eo (mandefa ID token)
 *   3. Andro vitsivitsy → esorina ny secret
 *   Raha ny frontend no alefa aloha dia tsy misy olana koa (mbola ekena ny secret).
 *   Fa raha esorina ny secret alohan'ny frontend dia TAPAKA ny push.
 *
 * Fampandehanana :  node patch-notify-idtoken-backend.cjs --dry
 *                   node patch-notify-idtoken-backend.cjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');

const F = path.join(process.cwd(), 'server.js');
const DRY = process.argv.includes('--dry');

if (!fs.existsSync(F)) {
  console.error('❌ Tsy hita ny server.js eto : ' + process.cwd());
  console.error("   Mandehana ao amin'ny racine an'ny backend (cd ~/Tsengo-backend).");
  process.exit(1);
}

let s = fs.readFileSync(F, 'utf8');

if (s.includes('notifyAuth')) {
  console.log('⏭  server.js : efa voapatch');
  process.exit(0);
}

const countOf = (str, sub) => str.split(sub).length - 1;
function rep(src, old, neo, label) {
  const n = countOf(src, old);
  if (n !== 1) {
    throw new Error('ASSERTION FAIL [' + label + '] : nandrasana 1, nahitana ' + n +
      '\n--- old ---\n' + old.slice(0, 240) + '\n-----------');
  }
  return src.replace(old, neo);
}

const OLD = `app.post("/notify", async (req, res) => {
  if (NOTIFY_SECRET && req.headers["x-notify-secret"] !== NOTIFY_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }`;

const NEW = `/**
 * Fanamarinana ny mpiantso ny /notify.
 *
 * 1) Authorization: Bearer <firebase-id-token>  ← ARINDRAINA
 *    Voamarina amin'i Google, tsy azo foronina, ary fantatra ny uid marina.
 * 2) x-notify-secret                            ← TALOHA, ho esorina
 *    Ny secret dia hita ao anaty bundle public : tsy fiarovana marina izy,
 *    fa notazonina mandritra ny fifindrana mba tsy hisy push tapaka.
 *
 * @returns {{ok:true, uid:string|null, legacy:boolean} | {ok:false, code:number, error:string}}
 */
async function notifyAuth(req) {
  const authz = req.headers["authorization"] || "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";

  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      return { ok: true, uid: decoded.uid, legacy: false };
    } catch (e) {
      return { ok: false, code: 401, error: "Token invalide" };
    }
  }

  // ── Lalana taloha (ho esorina) ─────────────────────────────────────────
  if (NOTIFY_SECRET && req.headers["x-notify-secret"] === NOTIFY_SECRET) {
    // ⚠️ Rehefa tsy miseho intsony ity log ity mandritra ny andro vitsivitsy,
    //    dia ESORY ity bloc ity manontolo ary avelao 401 ihany.
    console.warn("notify: legacy secret (bundle tranainy) — ho esorina");
    return { ok: true, uid: null, legacy: true };
  }

  return { ok: false, code: 401, error: "Authentification requise" };
}

app.post("/notify", async (req, res) => {
  const auth = await notifyAuth(req);
  if (!auth.ok) return res.status(auth.code).json({ error: auth.error });`;

s = rep(s, OLD, NEW, 'notify:auth');

/* ── Log ny mpandefa marina (fanaraha-maso) ──────────────────────────────── */
s = rep(s,
  '  const { toExternalId, title, message, data, fromPhoto } = req.body;\n  if (!toExternalId || !title || !message) {',
  '  const { toExternalId, title, message, data, fromPhoto } = req.body;\n' +
  '  if (auth.uid) req.__fromUid = auth.uid;   // mpandefa voamarina (fanaraha-maso)\n' +
  '  if (!toExternalId || !title || !message) {',
  'notify:trace');

if (!DRY) fs.writeFileSync(F, s);
console.log(DRY
  ? '✅ DRY-RUN : fanoloana 2 mety (tsy nisy nosoratana)'
  : '✅ Patch vita : server.js → /notify amin\'ny ID token (secret mbola ekena vonjimaika)');
