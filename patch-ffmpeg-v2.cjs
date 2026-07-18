// patch-ffmpeg-v2.cjs  (BACKEND — server.js)
// Fanitarana ny compression (dingana 2, mbola misy filet de sécurité) :
//   • Ny transcodage dia atao ALOHAN'ny routage → ny video ≤ 45 Mo rehetra
//     (na bot API na GramJS) dia voacompresser 720p + faststart.
//   • Timeout ampiakarina 150s → 240s (video lehibe kokoa).
//   • Raha misy tsy fetezany → ORIGINAL foana no alefa (tsy misy upload tapaka).
//   • Ny fichier transcodé dia soratana amin'ny disque ary ny req.file.path
//     dia atondro azy → ny GramJS (izay mamaky avy amin'ny disque) dia mandefa
//     ny KELY fa tsy ny original. Ny fichier multer taloha dia fafana avy hatrany.
//   • Chunk (> 45 Mo) : TSY KASIHINA — mandeha toy ny teo.
// Mila ny patch-video-ffmpeg.cjs (dingana 1) efa tafiditra. Idempotent.
const fs = require('fs');
const p = 'server.js';
let s = fs.readFileSync(p, 'utf8');

if (!s.includes('transcodeVideoSafe')) { console.log('❌ Dingana 1 (patch-video-ffmpeg.cjs) tsy mbola tafiditra.'); process.exit(1); }
const MARK = 'Compression video ≤45 Mo ALOHAN';
if (s.includes(MARK)) { console.log('⏭️  Deja applique.'); process.exit(0); }

// ── 1) Timeout 150s → 240s ──
const T_OLD = '}, 150000);';
if (s.split(T_OLD).length - 1 !== 1) { console.log('❌ ancre timeout introuvable/multiple'); process.exit(1); }
s = s.replace(T_OLD, '}, 240000);');
console.log('✅ timeout ffmpeg 150s → 240s');

// ── 2) Transcodage ALOHAN'ny auto-route GramJS ──
const ROUTE_OLD = `  // Auto-route: video >= 19MB → GramJS (2GB max)
  if (req.file.size >= 19 * 1024 * 1024 && req.file.mimetype.startsWith("video")) {
    return handleGramUpload(req, res);
  }`;
if (s.split(ROUTE_OLD).length - 1 !== 1) { console.log('❌ ancre auto-route introuvable/multiple'); process.exit(1); }
s = s.replace(ROUTE_OLD, `  // Compression video ≤45 Mo ALOHAN'ny routage (fallback: original raha misy olana)
  if (req.file.mimetype.startsWith("video") && req.file.size <= 45 * 1024 * 1024) {
    try {
      const orig = req.file.buffer || fsMod.readFileSync(req.file.path);
      const small = await transcodeVideoSafe(orig);
      if (small) {
        const np = require("path").join(require("os").tmpdir(), "tv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + ".mp4");
        fsMod.writeFileSync(np, small);
        if (req.file.path) { try { fsMod.unlinkSync(req.file.path); } catch {} }
        req.file.path = np;
        req.file.buffer = small;
        req.file.size = small.length;
        req.file.mimetype = "video/mp4";
        console.log("[ffmpeg] video: " + orig.length + " -> " + small.length + " octets");
      }
    } catch (e) { console.log("[ffmpeg] fallback original:", e.message); }
  }
  // Auto-route: video >= 19MB → GramJS (2GB max)
  if (req.file.size >= 19 * 1024 * 1024 && req.file.mimetype.startsWith("video")) {
    return handleGramUpload(req, res);
  }`);
console.log("✅ transcodage alohan'ny routage (≤45 Mo, na bot na GramJS)");

// ── 3) Esorina ny transcodage TALOHA tao anaty try (efa natao any ambony izao) ──
const INNER_OLD = `  try {
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
if (s.split(INNER_OLD).length - 1 !== 1) { console.log('❌ ancre bloc anaty introuvable/multiple'); process.exit(1); }
s = s.replace(INNER_OLD, `  try {
    const isAudio = req.file.mimetype.startsWith("audio");`);
console.log('✅ bloc transcodage anaty (dingana 1) nesorina — tsy atao indroa');

fs.writeFileSync(p, s);
console.log('✅ ffmpeg v2 vita.');
