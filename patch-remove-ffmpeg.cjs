// patch-remove-ffmpeg.cjs  (BACKEND — server.js)
// Araka ny fanapahan-kevitra :
//   1. ESORINA TANTERAKA ny ffmpeg (helper + fampiasana azy) — ny video dia
//      alefa ORIGINAL tsy miova toy ny taloha, amin'ny lalana rehetra.
//   2. Ny fetran'ny morceaux dia ampiakarina 30 → 60 mba hahazakana ny
//      morceaux 9 Mo (60 × 9 Mo ≈ 540 Mo ≥ ny fetra 500 Mo efa misy).
// Tsy misy fanovana hafa. Idempotent.
const fs = require('fs');
const p = 'server.js';
let s = fs.readFileSync(p, 'utf8');

let changed = 0;

// ── 1) Esorina ny bloc transcodage ao anaty /telegram/upload (raha mbola ao) ──
const INNER = `  try {
    // Compression video (fallback: original raha misy olana)
    if (req.file.mimetype.startsWith("video")) {
      const orig = req.file.buffer || fsMod.readFileSync(req.file.path);
      const small = await transcodeVideoSafe(orig);
      if (small) {
        req.file.buffer = small;
        req.file.size = small.length;
        req.file.mimetype = "video/mp4";
        console.log("[ffmpeg] video: " + orig.length + " -> " + small.length + " octets");
      } else if (!req.file.buffer) {
        req.file.buffer = orig;
      }
    }
    const isAudio = req.file.mimetype.startsWith("audio");`;
const INNER_NEW = `  try {
    const isAudio = req.file.mimetype.startsWith("audio");`;
if (s.includes(INNER)) {
  s = s.replace(INNER, INNER_NEW);
  changed++; console.log('✅ bloc transcodage /telegram/upload nesorina — video alefa ORIGINAL');
} else if (!s.includes('transcodeVideoSafe(')) {
  console.log('⏭️  bloc transcodage efa tsy misy');
} else {
  // Mety misy variante v2 — tsy tokony hitranga eto, fa arovana
  console.log('❌ bloc transcodage hita fa tsy mifanaraka amin ny endrika andrasana'); process.exit(1);
}

// ── 2) Esorina ny helper ffmpeg manontolo (init + transcodeVideoSafe) ──
const H_START = '// ── Compression vidéo (ffmpeg) — miaraka amin\'ny FILET DE SÉCURITÉ ──';
const H_END   = 'app.post("/telegram/upload", upload.single("file"), async (req, res) => {';
if (s.includes(H_START)) {
  const i0 = s.indexOf(H_START);
  const i1 = s.indexOf(H_END, i0);
  if (i1 < 0) { console.log('❌ faran ny helper tsy hita'); process.exit(1); }
  s = s.slice(0, i0) + s.slice(i1);
  changed++; console.log('✅ helper ffmpeg (transcodeVideoSafe + init) nesorina manontolo');
} else {
  console.log('⏭️  helper ffmpeg efa tsy misy');
}
if (s.includes('transcodeVideoSafe') || s.includes('fluent-ffmpeg')) {
  console.log('❌ mbola misy sisa ffmpeg — hamarino'); process.exit(1);
}

// ── 3) Morceaux : max 30 → 60 (ho an ny morceaux 9 Mo, hatramin ny ~540 Mo) ──
const C_OLD = 'if (!t || t < 1 || t > 30) return res.status(400).json({ error: "Nombre de morceaux invalide (max 30 = 500 Mo)" });';
const C_NEW = 'if (!t || t < 1 || t > 60) return res.status(400).json({ error: "Nombre de morceaux invalide (max 60)" });';
if (s.includes(C_NEW)) console.log('⏭️  max morceaux 60 — efa vita');
else {
  const n = s.split(C_OLD).length - 1;
  if (n !== 1) { console.log('❌ ancre max morceaux introuvable/multiple (' + n + ')'); process.exit(1); }
  s = s.replace(C_OLD, C_NEW);
  changed++; console.log('✅ max morceaux : 30 → 60');
}

if (changed) fs.writeFileSync(p, s);
console.log('✅ Vita : tsy misy ffmpeg intsony, morceaux 9 Mo zaka hatramin ny 500 Mo.');
