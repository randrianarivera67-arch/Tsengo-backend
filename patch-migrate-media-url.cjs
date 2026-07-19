// patch-migrate-media-url.cjs  (BACKEND — server.js)
// Route VONJIMAIKA hanovana ny URL media TALOHA voatahiry ao Firestore :
//   onrender.com/media-id  →  tsengo-upload.randrianarivera67.workers.dev/media-id
// Host swap MADIO (lalana mitovy) → tsy mety manimba URL mihitsy :
//   - raha efa workers.dev → tsy ovaina (idempotent)
//   - raha tsy misy ilay host → tsy ovaina
//   - raha misy → soloina fotsiny ny anaran'ny host, mitovy ny file_id
// Deep-walk : mandalo ny field REHETRA (mediaURL, thumbURL, photoURL, coverURL,
//   sharedFrom.*, authorPhoto, comments...) fa tsy voafetra.
// Fiarovana : mila ?secret=<NOTIFY_SECRET>. Dry-run : ?dry=1 (manisa fotsiny, tsy manoratra).
// Idempotent (azo averina). Esory ny route rehefa vita raha tianao.
const fs = require('fs');
const p = 'server.js';
let s = fs.readFileSync(p, 'utf8');

if (s.includes('/admin/migrate-media')) { console.log('⏭️  Deja applique.'); process.exit(0); }

// Apetraka eo alohan'ny "app.listen" na eo amin'ny faran'ny routes
const ANCHOR = 'app.listen(';
const idx = s.indexOf(ANCHOR);
if (idx < 0) { console.log('❌ app.listen introuvable'); process.exit(1); }

const ROUTE = `
// ── Migration vonjimaika : URL media onrender → Worker (host swap madio) ──
const OLD_MEDIA_HOST = "tsengo-backend.onrender.com/media-id";
const NEW_MEDIA_HOST = "tsengo-upload.randrianarivera67.workers.dev/media-id";

function swapMediaDeep(val) {
  // Mamerina [vaovao, changed] — deep-walk string/objet/array
  if (typeof val === "string") {
    if (val.includes(OLD_MEDIA_HOST)) return [val.split(OLD_MEDIA_HOST).join(NEW_MEDIA_HOST), true];
    return [val, false];
  }
  if (Array.isArray(val)) {
    let ch = false;
    const out = val.map(v => { const [nv, c] = swapMediaDeep(v); if (c) ch = true; return nv; });
    return [out, ch];
  }
  if (val && typeof val === "object") {
    let ch = false;
    const out = {};
    for (const k of Object.keys(val)) { const [nv, c] = swapMediaDeep(val[k]); if (c) ch = true; out[k] = nv; }
    return [out, ch];
  }
  return [val, false];
}

app.get("/admin/migrate-media", async (req, res) => {
  if (NOTIFY_SECRET && req.query.secret !== NOTIFY_SECRET) return res.status(403).json({ error: "Forbidden" });
  const dry = req.query.dry === "1" || req.query.dry === "true";
  const collections = ["posts", "stories", "users", "shops", "artists", "groups", "pages", "announcements", "events", "notes", "ads"];
  const report = {};
  try {
    const db = admin.firestore();
    for (const col of collections) {
      let scanned = 0, changed = 0;
      const snap = await db.collection(col).get();
      let batch = db.batch(); let inBatch = 0;
      for (const doc of snap.docs) {
        scanned++;
        const [nv, ch] = swapMediaDeep(doc.data());
        if (ch) {
          changed++;
          if (!dry) {
            batch.set(doc.ref, nv);
            inBatch++;
            if (inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
          }
        }
      }
      if (!dry && inBatch > 0) await batch.commit();
      report[col] = { scanned, changed };
    }
    res.json({ dry, done: true, report });
  } catch (e) {
    res.status(500).json({ error: e.message, report });
  }
});

`;

s = s.slice(0, idx) + ROUTE + s.slice(idx);
fs.writeFileSync(p, s);
console.log('✅ Route /admin/migrate-media apetraka (dry-run + secret).');
