// patch-fix-timestamps.cjs  (BACKEND — server.js)
// Mamerina ny Timestamp simba (lasa map {_seconds,_nanoseconds} tamin'ny
// /admin/migrate-media) ho Timestamp tena izy. Idempotent.
const fs = require('fs');
const p = 'server.js';
let s = fs.readFileSync(p, 'utf8');

let did = false;

// Guard: swapMediaDeep tsy hanimba Timestamp intsony (raha mbola ao izy)
const GUARD = '  if (val && typeof val === "object" && !Array.isArray(val) && val.constructor !== Object) return [val, false]; // Timestamp: tsy kitihina\n';
const SWAP_ANCHOR = 'function swapMediaDeep(val) {\n';
if (s.includes('swapMediaDeep') && !s.includes('Timestamp: tsy kitihina')) {
  const i = s.indexOf(SWAP_ANCHOR);
  if (i >= 0) {
    const at = i + SWAP_ANCHOR.length;
    s = s.slice(0, at) + GUARD + s.slice(at);
    console.log('OK guard swapMediaDeep');
    did = true;
  }
} else if (!s.includes('swapMediaDeep')) {
  console.log('info: tsy misy swapMediaDeep (tsy maninona)');
}

if (s.includes('/admin/fix-timestamps')) {
  console.log('efa nampiharina ny route');
} else {
  const ANCHOR = 'app.listen(';
  const idx = s.indexOf(ANCHOR);
  if (idx < 0) { console.log('ERREUR: app.listen tsy hita'); process.exit(1); }

  const ROUTE = `
// Fanarenana Timestamp simba (map -> Timestamp)
function looksLikeBrokenTs(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (v instanceof admin.firestore.Timestamp) return false;
  if (v.constructor !== Object) return false;
  const keys = Object.keys(v);
  if (keys.length < 1 || keys.length > 2) return false;
  const ok = keys.every(k => ["_seconds", "_nanoseconds", "seconds", "nanoseconds"].includes(k));
  if (!ok) return false;
  const sec = ("_seconds" in v) ? v._seconds : v.seconds;
  const nan = ("_nanoseconds" in v) ? v._nanoseconds : (v.nanoseconds ?? 0);
  return typeof sec === "number" && typeof nan === "number";
}
function fixTsDeep(val) {
  if (val instanceof admin.firestore.Timestamp) return [val, false];
  if (Array.isArray(val)) {
    let ch = false;
    const out = val.map(v => { const [nv, c] = fixTsDeep(v); if (c) ch = true; return nv; });
    return [out, ch];
  }
  if (val && typeof val === "object" && val.constructor === Object) {
    if (looksLikeBrokenTs(val)) {
      const sec = ("_seconds" in val) ? val._seconds : val.seconds;
      const nan = ("_nanoseconds" in val) ? val._nanoseconds : (val.nanoseconds ?? 0);
      return [new admin.firestore.Timestamp(sec, nan), true];
    }
    let ch = false;
    const out = {};
    for (const k of Object.keys(val)) { const [nv, c] = fixTsDeep(val[k]); if (c) ch = true; out[k] = nv; }
    return [out, ch];
  }
  return [val, false];
}

app.get("/admin/fix-timestamps", async (req, res) => {
  if (NOTIFY_SECRET && req.query.secret !== NOTIFY_SECRET) return res.status(403).json({ error: "Forbidden" });
  const dry = req.query.dry === "1" || req.query.dry === "true";
  const collections = ["posts", "stories", "users", "shops", "artists", "groups", "pages",
                       "announcements", "events", "notes", "ads", "notifications", "friendRequests", "reports"];
  const report = {};
  try {
    const db = admin.firestore();
    for (const col of collections) {
      let scanned = 0, changed = 0;
      const snap = await db.collection(col).get().catch(() => null);
      if (!snap) { report[col] = { scanned: 0, changed: 0, note: "tsy hita" }; continue; }
      let batch = db.batch(); let inBatch = 0;
      for (const d of snap.docs) {
        scanned++;
        const [nv, ch] = fixTsDeep(d.data());
        if (ch) {
          changed++;
          if (!dry) {
            batch.set(d.ref, nv);
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
  console.log('OK route /admin/fix-timestamps');
  did = true;
}

if (did) fs.writeFileSync(p, s);
console.log(did ? 'server.js voavonjy' : 'tsy nisy fiovana');
