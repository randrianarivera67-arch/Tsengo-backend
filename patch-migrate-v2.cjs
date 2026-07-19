// patch-migrate-v2.cjs  (BACKEND — server.js)
// Ampitomboina ny migration mba hanova ny host TALOHA amin'ny lalana media ROA :
//   onrender.com/media-id  → worker/media-id   (photo + video kely)
//   onrender.com/chunked   → worker/chunked    (video lehibe)
// Host swap madio ihany (lalana mitovy) → tsy mety manimba. Idempotent.
const fs = require('fs');
const p = 'server.js';
let s = fs.readFileSync(p, 'utf8');

if (s.includes('MEDIA_PATHS')) { console.log('⏭️  Deja applique.'); process.exit(0); }

const OLD = `const OLD_MEDIA_HOST = "tsengo-backend.onrender.com/media-id";
const NEW_MEDIA_HOST = "tsengo-upload.randrianarivera67.workers.dev/media-id";

function swapMediaDeep(val) {
  // Mamerina [vaovao, changed] — deep-walk string/objet/array
  if (typeof val === "string") {
    if (val.includes(OLD_MEDIA_HOST)) return [val.split(OLD_MEDIA_HOST).join(NEW_MEDIA_HOST), true];
    return [val, false];
  }`;

const NEW = `const OLD_HOST = "tsengo-backend.onrender.com";
const NEW_HOST = "tsengo-upload.randrianarivera67.workers.dev";
const MEDIA_PATHS = ["/media-id", "/chunked"];

function swapMediaDeep(val) {
  // Mamerina [vaovao, changed] — deep-walk string/objet/array
  if (typeof val === "string") {
    let out = val, changed = false;
    for (const pth of MEDIA_PATHS) {
      const oldp = OLD_HOST + pth;
      if (out.includes(oldp)) { out = out.split(oldp).join(NEW_HOST + pth); changed = true; }
    }
    return [out, changed];
  }`;

const n = s.split(OLD).length - 1;
if (n !== 1) { console.log('❌ ancre migration introuvable/multiple (' + n + ')'); process.exit(1); }
s = s.replace(OLD, NEW);
fs.writeFileSync(p, s);
console.log('✅ Migration ampitomboina : /media-id SY /chunked (photo + video lehibe taloha).');
