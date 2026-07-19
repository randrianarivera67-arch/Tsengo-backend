// patch-remove-migration.cjs  (BACKEND — server.js)
// Manesotra NY ROUTE /admin/migrate-media IHANY (efa vita ny migration).
// TSY mikasika ny sisa (chunked→Worker, media-id, sns.). Idempotent.
const fs = require('fs');
const p = 'server.js';
let s = fs.readFileSync(p, 'utf8');

const START = "// ── Migration vonjimaika : URL media onrender → Worker (host swap madio) ──";
const END = 'app.listen(';

if (!s.includes(START)) { console.log('⏭️  Route migration efa tsy misy.'); process.exit(0); }

const i0 = s.indexOf(START);
const i1 = s.indexOf(END, i0);
if (i1 < 0) { console.log('❌ app.listen tsy hita'); process.exit(1); }

// Fiarovana: hamarinina fa ny faritra esorina dia tena ny migration (misy ny anaran'ny route)
const block = s.slice(i0, i1);
if (!block.includes('/admin/migrate-media') || !block.includes('swapMediaDeep')) {
  console.log('❌ Ny faritra tsy mifanaraka amin\'ny migration — tsy manesotra'); process.exit(1);
}
// Fiarovana fanampiny: tsy tokony hisy MEDIA_WORKER (chunked) ao anatiny
if (block.includes('MEDIA_WORKER')) {
  console.log('❌ Misy MEDIA_WORKER ao anaty faritra — mety mifangaro, tsy manesotra'); process.exit(1);
}

s = s.slice(0, i0) + s.slice(i1);
fs.writeFileSync(p, s);

// Verif farany
if (s.includes('/admin/migrate-media')) { console.log('❌ Mbola misy sisa'); process.exit(1); }
if (!s.includes('MEDIA_WORKER')) { console.log('⚠️  MEDIA_WORKER tsy hita — hamarino ny chunked→Worker!'); }
console.log('✅ Route /admin/migrate-media voaesotra. Ny sisa (chunked→Worker) mijanona.');
