/**
 * patch-notify-all-backend.cjs   —  BACKEND (Tsengo-backend)
 * ─────────────────────────────────────────────────────────────────────────────
 * BUT : route vaovao POST /notify-all
 *       Rehefa mamoaka publication ny ADMIN dia mahazo :
 *         • push FCM  (fitaovana rehetra)
 *         • notification anaty app (users/{uid} → collection `notifications`)
 *       ny mpampiasa REHETRA.
 *
 * FIAROVANA — io no tena zava-dehibe :
 *   Ny /notify efa misy dia miaro amin'ny `x-notify-secret`, izay HITA ao anaty
 *   bundle public. Raha nampiasaina teto dia afaka nandefa push amin'ny olona
 *   rehetra ny na iza na iza.
 *   Ka ity route ity dia mampiasa **Firebase ID token** :
 *     1. verifyIdToken()          → uid marina, tsy azo foronina
 *     2. users/{uid}.isAdmin===true → tsy admin dia 403
 *
 * FANATANJAHANA :
 *   • batch Firestore 450 (fetra 500)
 *   • multicast FCM 500 token isaky ny antso (fetra FCM)
 *   • fanadiovana ny token maty
 *   • tsy mandefa amin'ny admin nandefa
 *
 * Fampandehanana :  node patch-notify-all-backend.cjs --dry
 *                   node patch-notify-all-backend.cjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');

const F = path.join(process.cwd(), 'server.js');
const DRY = process.argv.includes('--dry');

if (!fs.existsSync(F)) {
  console.error('❌ Tsy hita ny server.js eto : ' + process.cwd());
  console.error('   Mandehana ao amin\'ny racine an\'ny backend aloha (cd ~/backend).');
  process.exit(1);
}

let s = fs.readFileSync(F, 'utf8');

if (s.includes('/notify-all')) {
  console.log('⏭  server.js : efa voapatch (/notify-all misy sahady)');
  process.exit(0);
}

const ANCHOR = 'app.post("/telegram/upload-large", upload.single("file"), async (req, res) => {';
const n = s.split(ANCHOR).length - 1;
if (n !== 1) {
  console.error('❌ ASSERTION FAIL : nandrasana 1 anchor, nahitana ' + n);
  process.exit(1);
}

const ROUTE = `// ═══════════════════════════════════════════════════════════════════════════
// POST /notify-all — Diffusion ADMIN mankany amin'ny mpampiasa REHETRA
// Auth : Authorization: Bearer <firebase-id-token>  (TSY x-notify-secret :
//        io dia hita ao anaty bundle public, ka azon'ny rehetra ampiasaina)
// ═══════════════════════════════════════════════════════════════════════════
app.post("/notify-all", async (req, res) => {
  if (!fcmReady) return res.status(500).json({ error: "FCM non configuré (FIREBASE_SERVICE_ACCOUNT)" });

  // ── 1) Fanamarinana ny mpiantso ──────────────────────────────────────────
  const authz = req.headers.authorization || "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  if (!idToken) return res.status(401).json({ error: "Token manquant" });

  let callerUid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    callerUid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: "Token invalide" });
  }

  const fdb = admin.firestore();

  // ── 2) Admin ihany ───────────────────────────────────────────────────────
  let meSnap;
  try { meSnap = await fdb.doc(\`users/\${callerUid}\`).get(); }
  catch (e) { return res.status(500).json({ error: "Firestore: " + e.message }); }
  if (!meSnap.exists || meSnap.data().isAdmin !== true) {
    return res.status(403).json({ error: "Réservé aux administrateurs" });
  }

  const { title, message, postId, fromName, fromPhoto } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: "title, message required" });

  try {
    // ── 3) Mpampiasa + tokens ──────────────────────────────────────────────
    const snap = await fdb.collection("users").get();
    const uids = [];
    const tokens = [];
    const seen = new Set();
    const owner = new Map();          // token → uid (ho an'ny fanadiovana)
    snap.forEach(d => {
      if (d.id === callerUid) return;                 // tsy mandefa amin'ny tena
      uids.push(d.id);
      const list = d.data().fcmTokens;
      if (Array.isArray(list)) {
        for (const t of list) {
          if (t && typeof t === "string" && !seen.has(t)) {
            seen.add(t); tokens.push(t); owner.set(t, d.id);
          }
        }
      }
    });

    const url = postId ? \`\${FRONTEND_URL}/post/\${postId}\` : FRONTEND_URL;
    const iconUrl = (fromPhoto && String(fromPhoto).startsWith("http"))
      ? fromPhoto : \`\${FRONTEND_URL}/icon-192.png\`;

    // ── 4) Notification anaty app (batch 450) ──────────────────────────────
    let written = 0;
    for (let i = 0; i < uids.length; i += 450) {
      const slice = uids.slice(i, i + 450);
      const batch = fdb.batch();
      for (const uid of slice) {
        batch.set(fdb.collection("notifications").doc(), {
          toUid: uid,
          fromUid: callerUid,
          fromName: fromName || "Trengo",
          fromPhoto: fromPhoto || "",
          type: "post",
          postId: postId || "",
          message,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
      written += slice.length;
    }

    // ── 5) Push FCM (multicast 500) ────────────────────────────────────────
    let sent = 0, failed = 0;
    const dead = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const result = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        data: Object.fromEntries(Object.entries({
          title, body: message, icon: iconUrl,
          type: "post", conversationId: "", postId: postId || "", url,
          meUid: "", otherUid: "", canReply: "",
          ns: NOTIFY_SECRET || "",
        }).map(([k, v]) => [k, String(v || "")])),
        android: { priority: "high" },
        webpush: {
          headers: { Urgency: "high", TTL: "259200" },
          fcmOptions: { link: url },
          notification: {
            title, body: message, icon: iconUrl,
            badge: \`\${FRONTEND_URL}/icon-96.png\`,
            vibrate: [250, 120, 250],
            actions: [
              { action: "open",  title: "Voir",   icon: \`\${FRONTEND_URL}/notif-open.png\` },
              { action: "close", title: "Fermer", icon: \`\${FRONTEND_URL}/notif-close.png\` },
            ],
          },
        },
      });
      sent += result.successCount;
      failed += result.failureCount;
      result.responses.forEach((r, k) => {
        const code = (r.error && r.error.code) || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          dead.push(chunk[k]);
        }
      });
    }

    // ── 6) Fanadiovana ny token maty ───────────────────────────────────────
    if (dead.length) {
      const byUser = new Map();
      for (const t of dead) {
        const u = owner.get(t);
        if (!u) continue;
        if (!byUser.has(u)) byUser.set(u, []);
        byUser.get(u).push(t);
      }
      for (const [u, ts] of byUser) {
        await fdb.doc(\`users/\${u}\`)
          .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...ts) })
          .catch(() => {});
      }
    }

    console.log(\`notify-all: \${uids.length} users, \${written} notifs, \${sent} push OK, \${failed} KO\`);
    res.json({ success: true, users: uids.length, notified: written, sent, failed, cleaned: dead.length });
  } catch (err) {
    console.error("notify-all:", err.message);
    res.status(500).json({ error: err.message });
  }
});

`;

s = s.replace(ANCHOR, ROUTE + ANCHOR);

if (!DRY) fs.writeFileSync(F, s);
console.log(DRY ? '✅ DRY-RUN : anchor hita, fanoloana mety (tsy nisy nosoratana)' : '✅ Patch vita : server.js → POST /notify-all');
