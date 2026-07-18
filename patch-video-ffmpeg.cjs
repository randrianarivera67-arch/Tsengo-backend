// patch-video-ffmpeg.cjs  (ho an'ny REPO BACKEND — Tsengo-backend)
// Compression vidéo ffmpeg — DINGANA 1, azo antoka ho an'ny Render FREE :
//   • Video KELY (<19 Mo, route /telegram/upload) IHANY no transcodée (720p max,
//     CRF 28, veryfast, +faststart) — zakan'ny Render Free tsara io habe io.
//   • FILET DE SÉCURITÉ : raha misy erreur / timeout (2min30) / vokatra LEHIBE kokoa
//     → alefa ny ORIGINAL tsy miova. TSY misy upload tapaka mihitsy.
//   • +faststart = ny "moov atom" atao eo am-piandohana → ny video manomboka
//     milalao avy hatrany (mamaha ny "loading lalandava").
//   • GramJS (≥19 Mo) sy chunked (≤500 Mo) : TSY KASIHINA amin'ity dingana ity
//     (tsy zakan'ny Free ny transcodage azy ireo — mbola mandeha toy ny teo izy).
// Idempotent + anchor unique guards.
const fs = require('fs');
const p = 'server.js';
let s = fs.readFileSync(p, 'utf8');

const MARK = 'transcodeVideoSafe';
if (s.includes(MARK)) { console.log('⏭️  Deja applique.'); process.exit(0); }

// ── 1) Helper apetraka eo alohan'ny route /telegram/upload ──
const ROUTE = 'app.post("/telegram/upload", upload.single("file"), async (req, res) => {';
if (s.split(ROUTE).length - 1 !== 1) { console.log('❌ ancre route introuvable/multiple'); process.exit(1); }

const HELPER = `// ── Compression vidéo (ffmpeg) — miaraka amin'ny FILET DE SÉCURITÉ ──
// Raha misy tsy fetezany (erreur, timeout, vokatra lehibe kokoa) dia averina
// ny ORIGINAL — tsy misy upload tapaka mihitsy noho ity.
let _ffmpegReady = false, _ffmpeg = null;
try {
  _ffmpeg = require("fluent-ffmpeg");
  _ffmpeg.setFfmpegPath(require("@ffmpeg-installer/ffmpeg").path);
  _ffmpegReady = true;
  console.log("[ffmpeg] pret — compression video kely activee");
} catch (e) {
  console.log("[ffmpeg] tsy azo nalaina — video alefa original:", e.message);
}

function transcodeVideoSafe(inputBuf) {
  return new Promise((resolve) => {
    if (!_ffmpegReady || !inputBuf || inputBuf.length < 300 * 1024) return resolve(null); // <300Ko: tsy sahaza
    const path0 = require("path"), os0 = require("os");
    const tag = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const tmpIn = path0.join(os0.tmpdir(), "vin_" + tag + ".bin");
    const tmpOut = path0.join(os0.tmpdir(), "vout_" + tag + ".mp4");
    let finished = false, cmd = null;
    const done = (buf) => {
      if (finished) return; finished = true;
      try { fsMod.unlinkSync(tmpIn); } catch {}
      try { fsMod.unlinkSync(tmpOut); } catch {}
      resolve(buf);
    };
    try { fsMod.writeFileSync(tmpIn, inputBuf); } catch { return done(null); }
    const timer = setTimeout(() => { try { cmd && cmd.kill("SIGKILL"); } catch {} done(null); }, 150000);
    try {
      cmd = _ffmpeg(tmpIn)
        .outputOptions([
          "-vf", "scale='min(720,iw)':-2",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
          "-c:a", "aac", "-b:a", "96k",
          "-movflags", "+faststart",
          "-max_muxing_queue_size", "1024",
        ])
        .on("end", () => {
          clearTimeout(timer);
          try {
            const out = fsMod.readFileSync(tmpOut);
            // Raisina raha KELY kokoa 12%+ fara-fahakeliny ihany — raha tsy izany original
            done(out.length > 0 && out.length < inputBuf.length * 0.88 ? out : null);
          } catch { done(null); }
        })
        .on("error", () => { clearTimeout(timer); done(null); })
        .save(tmpOut);
    } catch { clearTimeout(timer); done(null); }
  });
}

`;
s = s.replace(ROUTE, HELPER + ROUTE);

// ── 2) Ampiasaina ao anaty route (video kely <19Mo ihany no tonga eto) ──
const TRYA = '  try {\n    const isAudio = req.file.mimetype.startsWith("audio");';
if (s.split(TRYA).length - 1 !== 1) { console.log('❌ ancre try/isAudio introuvable/multiple'); process.exit(1); }
s = s.replace(TRYA,
`  try {
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
    const isAudio = req.file.mimetype.startsWith("audio");`);

fs.writeFileSync(p, s);
console.log('✅ ffmpeg (dingana 1) apetraka — video kely transcodée 720p, fallback original azo antoka.');
