// patch-backend-dataonly.cjs — À lancer dans le repo BACKEND (Tsengo-backend)
// Retire le bloc "notification" top-level des envois FCM → data-only pour le
// natif (le service Android custom construit la notif façon Messenger).
// Le web reste OK (webpush.notification est conservé).
const fs = require('fs');
const p = 'server.js';
if (!fs.existsSync(p)) { console.log('FAIL server.js introuvable (lance dans le repo backend)'); process.exit(1); }
let s = fs.readFileSync(p, 'utf8');
let n = 0;
const targets = [
  /\n\s*notification: \{ title, body: message \},/g,
  /\n\s*notification: \{ title: msg\.fromName, body: msg\.text \},/g,
];
for (const re of targets) {
  const before = s;
  s = s.replace(re, '');
  if (s !== before) n++;
}
if (n === 0) { console.log('SKIP deja data-only (aucun bloc notification top-level trouve)'); process.exit(0); }
fs.writeFileSync(p, s);
console.log('OK ' + n + ' bloc(s) notification top-level retire(s) -> data-only natif');
console.log('Deploie sur Render (git push) pour activer.');
