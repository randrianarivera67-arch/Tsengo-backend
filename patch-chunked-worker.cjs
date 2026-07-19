// patch-chunked-worker.cjs  (BACKEND — server.js)
// Ny video LEHIBE vaovao (/chunked) dia hampiasa ny Cloudflare WORKER ho host
// (fa tsy Render intsony) → tsy misy mandalo Render mihitsy ny lecture media.
//   • Ny UPLOAD (chunk/init, chunk/upload) mijanona amin'ny Render (tsy voakasika).
//   • Ny URL /chunked voatahiry dia manondro ny Worker.
//   • Mila ny Worker efa manana ny route /chunked (worker-full.js).
// Idempotent.
const fs = require('fs');
const p = 'server.js';
let s = fs.readFileSync(p, 'utf8');

const OLD = 'const url = `${BURL}/chunked?ids=${ids.join(",")}&sizes=${sizes.join(",")}&mime=${encodeURIComponent(sess.mime)}`;';
const NEW = 'const MEDIA_WORKER = process.env.MEDIA_WORKER_URL || "https://tsengo-upload.randrianarivera67.workers.dev";\n  const url = `${MEDIA_WORKER}/chunked?ids=${ids.join(",")}&sizes=${sizes.join(",")}&mime=${encodeURIComponent(sess.mime)}`;';

if (s.includes('MEDIA_WORKER')) { console.log('⏭️  Deja applique.'); process.exit(0); }
const n = s.split(OLD).length - 1;
if (n !== 1) { console.log('❌ ancre /chunked URL introuvable/multiple (' + n + ')'); process.exit(1); }
s = s.replace(OLD, NEW);
fs.writeFileSync(p, s);
console.log('✅ /chunked URL → Worker (video lehibe vaovao tsy mandalo Render).');
