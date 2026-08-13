/**
 * migration-authorphoto.mjs — Cloudinary → photo ankehitriny
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ MANOVA DONNÉES PRODUCTION. Tsy azo averina raha tsy misy backup.
 *
 * FIZOTRA TAKIANA (aza dinganina) :
 *   1)  node migration-authorphoto.mjs --dry        ← manisa ihany, tsy manoratra
 *   2)  node migration-authorphoto.mjs --backup     ← mitahiry JSON
 *   3)  node migration-authorphoto.mjs --go         ← manoratra
 *
 * ASA : ny URL misy `res.cloudinary.com` (kaonty nofoanana → sary vaky) dia
 *   soloina ny `photoURL` ANKEHITRINY an'ilay mpampiasa, na `''` raha tsy misy.
 *   Rehefa `''` dia hiseho ny avatar mahazatra (litera voalohany).
 *
 * SAHA VOAKASIKA (posts) :
 *   • authorPhoto
 *   • comments[].authorPhoto
 *
 * TSY VOAKASIKA : mediaURL, mediaURLs, thumbURL, content, reactions, views…
 *
 * FAMPIASANA NY CLÉ :
 *   Alaina ao amin'ny Render → Environment → FIREBASE_SERVICE_ACCOUNT
 *   export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
 */
import admin from 'firebase-admin';

const DRY    = process.argv.includes('--dry');
const BACKUP = process.argv.includes('--backup');
const GO     = process.argv.includes('--go');

if (!DRY && !BACKUP && !GO) {
  console.log('Fampiasana :\n  --dry     manisa ihany\n  --backup  mitahiry JSON\n  --go      manoratra');
  process.exit(0);
}

const RAW = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!RAW) { console.error('❌ FIREBASE_SERVICE_ACCOUNT tsy voafaritra'); process.exit(1); }
let cred;
try { cred = JSON.parse(RAW); }
catch { console.error('❌ FIREBASE_SERVICE_ACCOUNT tsy JSON manan-kery'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(cred) });
const db = admin.firestore();

const isCloudinary = (u) => typeof u === 'string' && u.includes('res.cloudinary.com');

// ── Cache ny photoURL ankehitriny ──────────────────────────────────────
const photoCache = new Map();
async function currentPhoto(uid) {
  if (!uid) return '';
  if (photoCache.has(uid)) return photoCache.get(uid);
  let p = '';
  try {
    const d = await db.collection('users').doc(uid).get();
    if (d.exists) {
      const u = d.data();
      p = (!isCloudinary(u.photoURL) && u.photoURL) ? u.photoURL : '';
    }
  } catch (e) { /* mpampiasa voafafa — '' */ }
  photoCache.set(uid, p);
  return p;
}

const stat = { docs: 0, touched: 0, author: 0, comments: 0, restored: 0, cleared: 0 };
const backup = [];
const updates = [];

console.log('Mamaky ny posts…\n');
const snap = await db.collection('posts').get();

for (const doc of snap.docs) {
  stat.docs++;
  const d = doc.data();
  const upd = {};
  let hit = false;

  if (isCloudinary(d.authorPhoto)) {
    const np = await currentPhoto(d.uid);
    upd.authorPhoto = np;
    stat.author++; hit = true;
    np ? stat.restored++ : stat.cleared++;
  }

  if (Array.isArray(d.comments) && d.comments.some(c => c && isCloudinary(c.authorPhoto))) {
    const nc = [];
    for (const c of d.comments) {
      if (c && isCloudinary(c.authorPhoto)) {
        const np = await currentPhoto(c.uid);
        nc.push({ ...c, authorPhoto: np });
        stat.comments++; np ? stat.restored++ : stat.cleared++;
      } else nc.push(c);
    }
    upd.comments = nc;
    hit = true;
  }

  if (!hit) continue;
  stat.touched++;
  if (BACKUP) backup.push({ id: doc.id, authorPhoto: d.authorPhoto ?? null, comments: d.comments ?? null });
  updates.push({ ref: doc.ref, upd });
}

console.log('── Vokatra ──');
console.log('  posts nodinihina  :', stat.docs);
console.log('  posts hovana      :', stat.touched);
console.log('    authorPhoto     :', stat.author);
console.log('    commentaire     :', stat.comments);
console.log('  → sary naverina   :', stat.restored);
console.log('  → nofoanana ("")  :', stat.cleared);

if (BACKUP) {
  const fs = await import('fs');
  const name = 'backup-authorphoto-' + Date.now() + '.json';
  fs.writeFileSync(name, JSON.stringify(backup, null, 2));
  console.log('\n💾 Backup :', name, '(' + backup.length + ' doc)');
}

if (!GO) {
  console.log('\n⏸  Tsy nisy nosoratana. Ampiasao --go rehefa vonona.');
  process.exit(0);
}

// ── Fanoratana miaraka amin'ny batch 400 ───────────────────────────────
console.log('\nManoratra…');
let done = 0;
for (let i = 0; i < updates.length; i += 400) {
  const batch = db.batch();
  for (const u of updates.slice(i, i + 400)) batch.update(u.ref, u.upd);
  await batch.commit();
  done += Math.min(400, updates.length - i);
  console.log('  ' + done + ' / ' + updates.length);
}
console.log('\n✅ Vita :', done, 'posts voaova');
