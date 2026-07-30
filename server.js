const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");

const app = express();

const GRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || "0");
const GRAM_API_HASH = process.env.TELEGRAM_API_HASH || "";
const GRAM_SESSION = process.env.TELEGRAM_SESSION || "";
const GRAM_CHANNEL = process.env.TELEGRAM_CHANNEL_ID || "";
let TelegramClient, StringSession, Api;
let gramClient = null, gramReady = false;
try {
  ({ TelegramClient } = require("telegram"));
  ({ StringSession } = require("telegram/sessions"));
  ({ Api } = require("telegram"));
  gramReady = true;
  console.log("GramJS loaded OK");
} catch(e) {
  console.log("GramJS not available:", e.message);
}
async function getGramClient() {
  if (!gramReady) throw new Error("GramJS not installed");
  if (!GRAM_API_ID || !GRAM_API_HASH || !GRAM_SESSION) throw new Error("Missing TELEGRAM env vars");
  if (gramClient && gramClient.connected) return gramClient;
  const c = new TelegramClient(new StringSession(GRAM_SESSION), GRAM_API_ID, GRAM_API_HASH, { connectionRetries: 5 });
  await c.connect();
  gramClient = c;
  console.log("GramJS connected OK");
  return c;
}

const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://tsengo-ai4n.vercel.app";
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// ── YouTube OAuth2 config ──────────────────────────────────────────────────
const YT_CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID     || "";
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || "";
const YT_REDIRECT_URI  = process.env.YOUTUBE_REDIRECT_URI  || `${FRONTEND_URL}/oauth/callback`;

// Multer : video en mémoire (max 500MB)
const fsMod = require("fs");
const osMod = require("os");
const TMP_DIR = require("path").join(osMod.tmpdir(), "traingo-uploads");
try { fsMod.mkdirSync(TMP_DIR, { recursive: true }); } catch {}
// Disque fa tsy RAM : ny fichier 300MB dia tsy mameno ny mémoire an'ny Render intsony
const upload = multer({ storage: multer.diskStorage({ destination: TMP_DIR }), limits: { fileSize: 320 * 1024 * 1024 } });
function cleanupUpload(req) {
  if (req?.file?.path) fsMod.unlink(req.file.path, () => {});
}

// Token YouTube du compte propriétaire (rafraîchi automatiquement)
let ownerRefreshToken = process.env.YOUTUBE_REFRESH_TOKEN || "";
let ownerAccessToken  = "";
let ownerTokenExpiry  = 0;

async function getOwnerAccessToken() {
  if (ownerAccessToken && Date.now() < ownerTokenExpiry - 60000) return ownerAccessToken;
  if (!ownerRefreshToken) throw new Error("YOUTUBE_REFRESH_TOKEN not configured");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     YT_CLIENT_ID,
      client_secret: YT_CLIENT_SECRET,
      refresh_token: ownerRefreshToken,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));
  ownerAccessToken = data.access_token;
  ownerTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return ownerAccessToken;
}

app.use(cors({ origin: true }));
app.use(express.json({ limit: "10kb" }));

// ═══ Firebase Admin (FCM push notifications — misolo ny OneSignal) ═══
const admin = require("firebase-admin");
let fcmReady = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      ...(process.env.FIREBASE_DB_URL ? { databaseURL: process.env.FIREBASE_DB_URL } : {}),
    });
    fcmReady = true;
    console.log("✅ Firebase Admin (FCM) prêt");
  } else {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT manquant — push FCM désactivé");
  }
} catch (e) {
  console.error("Firebase Admin init:", e.message);
}


app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));
const BACKEND_URL = process.env.BACKEND_URL || "https://tsengo-backend.onrender.com";
setInterval(async () => {
  try { await fetch(BACKEND_URL + "/ping"); console.log("Self-ping OK"); }
  catch(e) { console.log("Self-ping failed"); }
}, 14 * 60 * 1000);

app.get("/", (req, res) => {
  res.json({ status: "Traingo Backend OK 💠", version: "6.0.0" });
});

// ✅ YouTube — Exchange code → access_token + refresh_token
app.post("/youtube/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     YT_CLIENT_ID,
        client_secret: YT_CLIENT_SECRET,
        redirect_uri:  YT_REDIRECT_URI,
        grant_type:    "authorization_code",
      }),
    });
    const data = await r.json();
    // Sauvegarder le refresh_token propriétaire si c'est le premier
    if (data.refresh_token && !ownerRefreshToken) {
      ownerRefreshToken = data.refresh_token;
      console.log("✅ YOUTUBE_REFRESH_TOKEN=" + data.refresh_token);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ YouTube — Upload video (server-side, compte propriétaire)
app.post("/youtube/upload", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video file" });
  const title = req.body.title || `Traingo_${Date.now()}`;

  try {
    const token = await getOwnerAccessToken();

    // 1. Initiation upload resumable
    const initRes = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": req.file.mimetype || "video/mp4",
          "X-Upload-Content-Length": req.file.size,
        },
        body: JSON.stringify({
          snippet: { title, description: "Partagé via Traingo", categoryId: "22" },
          status:  { privacyStatus: "unlisted" },
        }),
      }
    );

    if (!initRes.ok) {
      const errText = await initRes.text();
      return res.status(500).json({ error: "YouTube init failed: " + errText });
    }

    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) return res.status(500).json({ error: "No upload URL" });

    // 2. Upload du fichier
    const upRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": req.file.mimetype || "video/mp4" },
      body: req.file.buffer || fsMod.readFileSync(req.file.path),
    });

    if (!upRes.ok) {
      const errText = await upRes.text();
      return res.status(500).json({ error: "YouTube upload failed: " + errText });
    }

    const videoData = await upRes.json();
    const videoId   = videoData.id;

    res.json({
      videoId,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ PROXY via file_path (fichiers < 20MB)
app.get("/media", async (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath || !BOT_TOKEN) return res.status(400).json({ error: "Missing path or token" });
  try {
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(404).json({ error: "File not found" });
    const ct = r.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=31536000");
    r.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Téléchargement RÉEL (Content-Disposition: attachment) — mamela ny navigateur
// mihitsy no mitantana ny "enregistrer sous", tsy misy fetch/blob/CORS amin'ny
// frontend intsony (izay no antony indraindray "code" (index.html) no voatahiry
// raha injay ny CORS na ny type an'ny blob tsy fantatra tsara).
app.get("/download", async (req, res) => {
  const { url, name, type } = req.query;
  if (!url) return res.status(400).send("Paramètre url manquant");
  try {
    const target = new URL(url);
    const backendHost = new URL(BACKEND_URL).host;
    // Sécurité : io endpoint io dia mamaky ihany ny fichiers avy amin'ny backend-nao
    // manokana (tsy open proxy ho an'ny URL hafa rehetra)
    if (target.host !== backendHost) {
      return res.status(403).send("URL non autorisée");
    }
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send("Téléchargement échoué (source indisponible)");
    let ct = r.headers.get("content-type") || (type === "video" ? "video/mp4" : "image/jpeg");
    let ext = ct.includes("/") ? ct.split("/")[1].split(";")[0] : (type === "video" ? "mp4" : "jpg");
    if (ext === "quicktime") ext = "mov";
    const filename = `${(name || "traingo_" + Date.now()).replace(/[^a-zA-Z0-9_\-]/g, "_")}.${ext}`;
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    r.body.pipe(res);
  } catch (err) {
    console.error("download route:", err.message);
    res.status(500).send("Erreur serveur : " + err.message);
  }
});

// ✅ PROXY via file_id — MISY Range support (streaming/seek fluide amin'ny video)
app.get("/media-id", async (req, res) => {
  const { file_id } = req.query;
  if (!file_id || !BOT_TOKEN) return res.status(400).json({ error: "Missing file_id or token" });
  try {
    const fRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${file_id}`);
    const fData = await fRes.json();
    if (!fData.ok || !fData.result.file_path) {
      return res.status(404).json({ error: "Cannot get file: " + (fData.description || "unknown") });
    }
    const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fData.result.file_path}`;

    // Devine le type via l'extension du file_path
    const fp = fData.result.file_path.toLowerCase();
    const ext = fp.split('.').pop();
    const mimeByExt = {
      mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm', mkv:'video/x-matroska',
      jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp',
      mp3:'audio/mpeg', ogg:'audio/ogg', oga:'audio/ogg', m4a:'audio/mp4', wav:'audio/wav',
    };
    const contentType = mimeByExt[ext] || 'application/octet-stream';

    const range = req.headers.range;
    // Transmet le Range à Telegram (Telegram supporte les requêtes Range)
    const upstreamHeaders = {};
    if (range) upstreamHeaders['Range'] = range;

    const r = await fetch(tgUrl, { headers: upstreamHeaders });
    if (!r.ok && r.status !== 206) return res.status(404).json({ error: "File not found" });

    // Recopie les en-têtes de streaming
    const len = r.headers.get('content-length');
    const cr  = r.headers.get('content-range');
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (len) res.setHeader("Content-Length", len);
    if (cr)  res.setHeader("Content-Range", cr);

    res.status(r.status === 206 ? 206 : 200);
    return r.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ OneSignal notify
// ✅ Réponse DIRECTE avy amin'ny notification (inline reply Android)
app.post("/reply", async (req, res) => {
  if (NOTIFY_SECRET && req.headers["x-notify-secret"] !== NOTIFY_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { conversationId, meUid, otherUid, text } = req.body || {};
  if (!conversationId || !meUid || !text?.trim()) return res.status(400).json({ error: "Champs manquants" });
  if (!fcmReady) return res.status(500).json({ error: "FCM non configuré" });
  if (!process.env.FIREBASE_DB_URL) return res.status(500).json({ error: "FIREBASE_DB_URL manquant sur le serveur" });
  // Fiarovana : ilay mamaly dia tsy maintsy ao anaty conversation
  if (!conversationId.startsWith("group_") && !conversationId.includes(meUid)) {
    return res.status(403).json({ error: "Non membre de la conversation" });
  }
  try {
    const meSnap = await admin.firestore().doc(`users/${meUid}`).get();
    const me = meSnap.exists ? meSnap.data() : {};
    const msg = {
      fromUid: meUid,
      ...(otherUid ? { toUid: otherUid } : {}),
      fromName: me.fullName || "Utilisateur",
      fromPhoto: me.photoURL || "",
      text: String(text).slice(0, 2000),
      ts: Date.now(),
      read: false,
    };
    await admin.database().ref(`conversations/${conversationId}/messages`).push(msg);
    await admin.database().ref(`conversations/${conversationId}/meta`).update({ lastMessage: msg.text, lastTs: msg.ts }).catch(() => {});

    // Ampandrenesina ilay nandefa fa nisy valiny
    if (otherUid) {
      try {
        const oSnap = await admin.firestore().doc(`users/${otherUid}`).get();
        const oTokens = (oSnap.exists && oSnap.data().fcmTokens) || [];
        if (oTokens.length) {
          await admin.messaging().sendEachForMulticast({
            tokens: oTokens,
            data: { title: msg.fromName, body: msg.text, icon: msg.fromPhoto || `${FRONTEND_URL}/icon-192.png`, type: "message", conversationId, url: `${FRONTEND_URL}/messages/${conversationId}`, meUid: otherUid, otherUid: meUid, canReply: "1", ns: NOTIFY_SECRET || "" },
            android: { priority: "high" },
            webpush: {
              headers: { Urgency: "high" },
              fcmOptions: { link: `${FRONTEND_URL}/messages/${conversationId}` },
              notification: {
                title: msg.fromName, body: msg.text,
                icon: msg.fromPhoto && msg.fromPhoto.startsWith("http") ? msg.fromPhoto : `${FRONTEND_URL}/icon-192.png`,
                badge: `${FRONTEND_URL}/icon-96.png`,
                vibrate: [250, 120, 250],
                tag: `msg_${conversationId}`, renotify: true,
                actions: [
                  { action: "reply", type: "text", title: "Répondre", placeholder: "Votre message...", icon: `${FRONTEND_URL}/notif-reply.png` },
                  { action: "close", title: "Fermer", icon: `${FRONTEND_URL}/notif-close.png` },
                ],
              },
            },
          });
        }
      } catch (e) { console.warn("reply notify:", e.message); }
    }
    res.json({ success: true });
  } catch (err) {
    console.error("reply:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Fanamarinana ny mpiantso ny /notify.
 *
 * 1) Authorization: Bearer <firebase-id-token>  ← ARINDRAINA
 *    Voamarina amin'i Google, tsy azo foronina, ary fantatra ny uid marina.
 * 2) x-notify-secret                            ← TALOHA, ho esorina
 *    Ny secret dia hita ao anaty bundle public : tsy fiarovana marina izy,
 *    fa notazonina mandritra ny fifindrana mba tsy hisy push tapaka.
 *
 * @returns {{ok:true, uid:string|null, legacy:boolean} | {ok:false, code:number, error:string}}
 */
async function notifyAuth(req) {
  const authz = req.headers["authorization"] || "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";

  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      return { ok: true, uid: decoded.uid, legacy: false };
    } catch (e) {
      return { ok: false, code: 401, error: "Token invalide" };
    }
  }

  // ── Lalana taloha (ho esorina) ─────────────────────────────────────────
  if (NOTIFY_SECRET && req.headers["x-notify-secret"] === NOTIFY_SECRET) {
    // ⚠️ Rehefa tsy miseho intsony ity log ity mandritra ny andro vitsivitsy,
    //    dia ESORY ity bloc ity manontolo ary avelao 401 ihany.
    console.warn("notify: legacy secret (bundle tranainy) — ho esorina");
    return { ok: true, uid: null, legacy: true };
  }

  return { ok: false, code: 401, error: "Authentification requise" };
}

app.post("/notify", async (req, res) => {
  const auth = await notifyAuth(req);
  if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
  const { toExternalId, title, message, data, fromPhoto } = req.body;
  if (auth.uid) req.__fromUid = auth.uid;   // mpandefa voamarina (fanaraha-maso)
  if (!toExternalId || !title || !message) {
    return res.status(400).json({ error: "toExternalId, title, message required" });
  }
  if (!fcmReady) return res.status(500).json({ error: "FCM non configuré (FIREBASE_SERVICE_ACCOUNT)" });

  const notifType = data?.type || "general";
  const conversationId = data?.conversationId || "";
  const postId = data?.postId || "";
  let url = FRONTEND_URL;
  if (notifType === "message" && conversationId) url = `${FRONTEND_URL}/messages/${conversationId}`;
  else if (["post","like","reaction","comment"].includes(notifType) && postId) url = `${FRONTEND_URL}/post/${postId}`;
  else if (["follow","friendRequest","friendAccepted"].includes(notifType)) url = `${FRONTEND_URL}/friends`;

  try {
    // Alaina ny tokens FCM an'ilay olona ao amin'ny Firestore (users/{uid}.fcmTokens)
    const userSnap = await admin.firestore().doc(`users/${toExternalId}`).get();
    const tokens = (userSnap.exists && userSnap.data().fcmTokens) || [];
    if (!tokens.length) return res.json({ success: true, skipped: "aucun appareil abonné" });

    // Réponse directe : ilay olona nandefa = ny lafiny hafa ao amin'ny conversationId
    const otherUid = (notifType === "message" && conversationId && !conversationId.startsWith("group_"))
      ? conversationId.split("_").find(u => u !== toExternalId) || ""
      : "";

    const iconUrl = (fromPhoto && String(fromPhoto).startsWith("http")) ? fromPhoto : `${FRONTEND_URL}/icon-192.png`;
    const isMsg = notifType === "message";
    const ICON_REPLY = `${FRONTEND_URL}/notif-reply.png`;
    const ICON_CLOSE = `${FRONTEND_URL}/notif-close.png`;
    const ICON_OPEN  = `${FRONTEND_URL}/notif-open.png`;
    const actions = isMsg
      ? [{ action: "reply", type: "text", title: "Répondre", placeholder: "Votre message...", icon: ICON_REPLY }, { action: "close", title: "Fermer", icon: ICON_CLOSE }]
      : [{ action: "open", title: "Voir", icon: ICON_OPEN }, { action: "close", title: "Fermer", icon: ICON_CLOSE }];

    // HYBRIDE : "notification" = aseho HO AZY na mikatona tanteraka aza ny app
    // (io no antoka fa tonga foana) ; ny SW dia tsy mampiseho intsony (tsy misy doublon)
    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      data: Object.fromEntries(Object.entries({
        title, body: message, icon: iconUrl,
        type: notifType, conversationId, postId, url,
        meUid: toExternalId, otherUid,
        canReply: isMsg ? "1" : "",
        ns: NOTIFY_SECRET || "",
      }).map(([k, v]) => [k, String(v || "")])),
      android: { priority: "high" },
      webpush: {
        headers: { Urgency: "high", TTL: "259200" },
        fcmOptions: { link: url },
        notification: {
          title,
          body: message,
          icon: iconUrl,
          badge: `${FRONTEND_URL}/icon-96.png`,
          vibrate: [250, 120, 250],
          tag: isMsg ? `msg_${conversationId}` : undefined,
          renotify: isMsg || undefined,
          requireInteraction: isMsg || undefined,
          actions,
        },
      },
    });

    // Fanadiovana ny tokens maty (appareil niala / cache voafafa)
    const dead = [];
    result.responses.forEach((r, idx) => {
      const code = r.error?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) dead.push(tokens[idx]);
    });
    if (dead.length) {
      await admin.firestore().doc(`users/${toExternalId}`)
        .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) }).catch(() => {});
    }

    res.json({ success: true, sent: result.successCount, failed: result.failureCount });
  } catch (err) {
    console.error("FCM notify:", err.message);
    res.status(500).json({ error: err.message });
  }
});


async function handleGramUpload(req, res) {
  try {
    if (!GRAM_CHANNEL) throw new Error("Vidéo volumineuse : TELEGRAM_CHANNEL_ID / session GramJS non configurés sur le serveur");
    const client = await getGramClient();
    const isVideo = req.file.mimetype.startsWith("video");
    const { CustomFile } = require("telegram/client/uploads");
    // Streaming avy amin'ny disque — tsy mandany RAM na dia 300MB aza
    const fileToSend = req.file.path
      ? new CustomFile(req.file.originalname || "video.mp4", req.file.size, req.file.path)
      : req.file.buffer;
    const result = await client.sendFile(GRAM_CHANNEL, {
      file: fileToSend,
      caption: "",
      workers: 8,
      forceDocument: !isVideo,
      ...(isVideo ? { attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0, supportsStreaming: true })] } : {}),
    });
    const BURL = process.env.BACKEND_URL || "https://tsengo-backend.onrender.com";
    res.json({ url: BURL + "/stream/" + result.id, messageId: result.id, type: isVideo ? "video" : "file" });
  } catch(err) {
    console.error("GramJS upload error:", err.message);
    res.status(500).json({ error: "GramJS: " + err.message });
  } finally {
    cleanupUpload(req);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
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
  try { meSnap = await fdb.doc(`users/${callerUid}`).get(); }
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

    const url = postId ? `${FRONTEND_URL}/post/${postId}` : FRONTEND_URL;
    const iconUrl = (fromPhoto && String(fromPhoto).startsWith("http"))
      ? fromPhoto : `${FRONTEND_URL}/icon-192.png`;

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
            badge: `${FRONTEND_URL}/icon-96.png`,
            vibrate: [250, 120, 250],
            actions: [
              { action: "open",  title: "Voir",   icon: `${FRONTEND_URL}/notif-open.png` },
              { action: "close", title: "Fermer", icon: `${FRONTEND_URL}/notif-close.png` },
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
        await fdb.doc(`users/${u}`)
          .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...ts) })
          .catch(() => {});
      }
    }

    console.log(`notify-all: ${uids.length} users, ${written} notifs, ${sent} push OK, ${failed} KO`);
    res.json({ success: true, users: uids.length, notified: written, sent, failed, cleaned: dead.length });
  } catch (err) {
    console.error("notify-all:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/telegram/upload-large", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  return handleGramUpload(req, res);
});

app.get("/stream/:messageId", async (req, res) => {
  try {
    const client = await getGramClient();
    const msgId = parseInt(req.params.messageId);
    const [msg] = await client.getMessages(GRAM_CHANNEL, { ids: [msgId] });
    if (!msg || !msg.media) return res.status(404).json({ error: "Not found" });
    const doc = msg.media.document;
    if (!doc) return res.status(400).json({ error: "No document" });
    const fileSize = Number(doc.size);
    const mimeType = doc.mimeType || "video/mp4";
    const fileLocation = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: "",
    });
    const range = req.headers.range;
    let start = 0, end = fileSize - 1;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      if (m) { start = parseInt(m[1])||0; end = m[2] ? Math.min(parseInt(m[2]), fileSize-1) : fileSize-1; }
    }
    const chunkLen = end - start + 1;
    res.writeHead(range ? 206 : 200, {
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkLen,
      "Content-Range": "bytes " + start + "-" + end + "/" + fileSize,
      "Cache-Control": "public, max-age=86400",
    });
    let written = 0;
    for await (const chunk of client.iterDownload({
      file: fileLocation,
      dcId: doc.dcId,
      fileSize: BigInt(fileSize),
      requestSize: 1024 * 1024,
      offset: BigInt(start),
    })) {
      if (!res.writable) break;
      const remaining = chunkLen - written;
      if (chunk.length >= remaining) { res.write(chunk.slice(0, remaining)); break; }
      res.write(chunk);
      written += chunk.length;
      if (written >= chunkLen) break;
    }
    res.end();
  } catch(err) {
    console.error("Stream error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ✅ Telegram — Upload video lehibe (hatramin'ny 2GB)
app.post("/telegram/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  // Auto-route: video >= 19MB → GramJS (2GB max)
  if (req.file.size >= 19 * 1024 * 1024 && req.file.mimetype.startsWith("video")) {
    return handleGramUpload(req, res);
  }
  try {
    const isAudio = req.file.mimetype.startsWith("audio");
    const form = new (require('form-data'))();
    form.append('chat_id', process.env.TELEGRAM_CHAT_ID);
    const fileBuf = req.file.buffer || fsMod.readFileSync(req.file.path);
    const defaultName = isAudio ? 'audio.mp3' : (req.file.mimetype.startsWith('video') ? 'video.mp4' : 'file');
    const filename = req.file.originalname || defaultName;

    // Audio -> sendAudio (mitahiry ho audio marina) ; hafa -> sendDocument
    const tgMethod = isAudio ? 'sendAudio' : 'sendDocument';
    const tgField  = isAudio ? 'audio' : 'document';
    form.append(tgField, fileBuf, { filename, contentType: req.file.mimetype });
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${tgMethod}`, { method: 'POST', body: form, headers: form.getHeaders() });
    const data = await r.json();
    if (!data.ok) {
      if (req.file.mimetype.startsWith("video")) return handleGramUpload(req, res);
      return res.status(500).json({ error: data.description });
    }
    const fileId = data.result.document?.file_id || data.result.video?.file_id || data.result.audio?.file_id;
    if (!fileId) return res.status(500).json({ error: "Telegram n'a pas renvoyé de file_id" });
    const type = req.file.mimetype.startsWith('video') ? 'video' : isAudio ? 'audio' : 'image';
    // ✅ FIX : ny lecture média dia avy amin'ny Cloudflare Worker (edge, tsy matory)
    // fa tsy ny Render (free tier — cold start 30-60s → sary fotsy/tsy miseho).
    const MEDIA_BASE = process.env.MEDIA_WORKER_URL || "https://tsengo-upload.randrianarivera67.workers.dev";
    const proxyUrl = `${MEDIA_BASE}/media-id?file_id=${fileId}`;
    cleanupUpload(req);
    res.json({ url: proxyUrl, fileId, type });
  } catch (err) {
    cleanupUpload(req);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ✅ UPLOAD EN MORCEAUX — vidéo jusqu'à 500 Mo via Bot API (sans GramJS)
// Frontend manapaka ny vidéo ho morceaux ≤18MB → alefa tsirairay →
// Telegram mitahiry → /chunked mandrafitra azy ho vidéo TOKANA amin'ny lecture
// ═══════════════════════════════════════════════════════════════
const chunkSessions = new Map(); // uploadId -> { total, mime, name, chunks, ts }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of chunkSessions) if (now - v.ts > 60 * 60 * 1000) chunkSessions.delete(k);
}, 10 * 60 * 1000);
const filePathCache = new Map(); // fileId -> { path, ts } (lalana Telegram, manan-kery ~1h)

app.post("/chunk/init", (req, res) => {
  const { total, mime, name } = req.body || {};
  const t = Number(total);
  if (!t || t < 1 || t > 60) return res.status(400).json({ error: "Nombre de morceaux invalide (max 60)" });
  const uploadId = require("crypto").randomBytes(16).toString("hex");
  chunkSessions.set(uploadId, { total: t, mime: mime || "video/mp4", name: name || "video.mp4", chunks: {}, ts: Date.now() });
  res.json({ uploadId });
});

app.post("/chunk/upload", upload.single("file"), async (req, res) => {
  const { uploadId, index } = req.body || {};
  const sess = chunkSessions.get(uploadId);
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    if (!sess) return res.status(410).json({ error: "Session d'upload expirée — relancez l'envoi" });
    const idx = Number(index);
    if (isNaN(idx) || idx < 0 || idx >= sess.total) return res.status(400).json({ error: "Index invalide" });
    sess.ts = Date.now();
    const form = new (require("form-data"))();
    form.append("chat_id", process.env.TELEGRAM_CHAT_ID);
    const buf = req.file.buffer || fsMod.readFileSync(req.file.path);
    form.append("document", buf, { filename: `traingo_${uploadId}_${idx}.part`, contentType: "application/octet-stream" });
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: form, headers: form.getHeaders() });
    const data = await r.json();
    if (!data.ok) {
      // ✅ FIX flood : ampitaina amin'ny client ny "retry_after" mba hiandry araka
      // ny tokony ho izy (fa tsy hijanona amin'ny erreur amin'ny fanapahana video)
      const ra = data.parameters?.retry_after;
      const desc = data.description || "Erreur Telegram";
      return res.status(ra ? 429 : 500).json({ error: ra ? `Too Many Requests: retry after ${ra}` : desc, retry_after: ra });
    }
    const fileId = data.result.document?.file_id;
    if (!fileId) return res.status(500).json({ error: "Telegram n'a pas renvoyé de file_id" });
    sess.chunks[idx] = { fileId, size: req.file.size };
    res.json({ ok: true, index: idx, received: Object.keys(sess.chunks).length, total: sess.total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    cleanupUpload(req);
  }
});

app.post("/chunk/complete", (req, res) => {
  const { uploadId } = req.body || {};
  const sess = chunkSessions.get(uploadId);
  if (!sess) return res.status(410).json({ error: "Session expirée" });
  const ids = [], sizes = [];
  for (let i = 0; i < sess.total; i++) {
    if (!sess.chunks[i]) return res.status(400).json({ error: `Morceau ${i + 1}/${sess.total} manquant` });
    ids.push(sess.chunks[i].fileId);
    sizes.push(sess.chunks[i].size);
  }
  chunkSessions.delete(uploadId);
  const BURL = process.env.BACKEND_URL || "https://tsengo-backend.onrender.com";
  const MEDIA_WORKER = process.env.MEDIA_WORKER_URL || "https://tsengo-upload.randrianarivera67.workers.dev";
  const url = `${MEDIA_WORKER}/chunked?ids=${ids.join(",")}&sizes=${sizes.join(",")}&mime=${encodeURIComponent(sess.mime)}`;
  res.json({ url, type: sess.mime.startsWith("video") ? "video" : "file" });
});

async function getChunkPath(fileId) {
  const cached = filePathCache.get(fileId);
  if (cached && Date.now() - cached.ts < 50 * 60 * 1000) return cached.path;
  const fRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fData = await fRes.json();
  if (!fData.ok || !fData.result?.file_path) throw new Error("Morceau introuvable sur Telegram");
  filePathCache.set(fileId, { path: fData.result.file_path, ts: Date.now() });
  return fData.result.file_path;
}

// ── Cache DISQUE ny morceaux (lecture fluide, seek instantané) ──
const pathMod = require("path");
const CHUNK_CACHE_DIR = pathMod.join(osMod.tmpdir(), "traingo-chunk-cache");
try { fsMod.mkdirSync(CHUNK_CACHE_DIR, { recursive: true }); } catch {}
const chunkCacheIndex = new Map();      // fileId -> { file, size, ts }
const chunkDownloads  = new Map();      // fileId -> Promise (tsy miverina indroa)
const CHUNK_CACHE_MAX = 1200 * 1024 * 1024; // 1,2 Go farafahabetsany /tmp (video 500 Mo + hafa)

function pruneChunkCache() {
  let total = 0;
  const entries = [...chunkCacheIndex.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (const [, v] of entries) total += v.size;
  while (total > CHUNK_CACHE_MAX && entries.length) {
    const [fid, v] = entries.shift();
    try { fsMod.unlinkSync(v.file); } catch {}
    chunkCacheIndex.delete(fid);
    total -= v.size;
  }
}

// Maka morceau iray -> fichier local (cache). res (optionnel) : alefa MIVANTANA
// any amin'ny mpijery ny fenêtre [winStart..winEnd] eo am-pakana azy (tee) —
// tsy miandry ny 18 Mo ho feno intsony vao manomboka ny lecture.
function getChunkFile(fileId, res = null, winStart = 0, winEnd = -1) {
  const hit = chunkCacheIndex.get(fileId);
  if (hit && fsMod.existsSync(hit.file)) { hit.ts = Date.now(); return Promise.resolve({ file: hit.file, streamed: false }); }
  if (chunkDownloads.has(fileId)) {
    // Efa misy téléchargement mandeha : miandry azy dia avy amin'ny disque
    return chunkDownloads.get(fileId).then(r => ({ file: r.file, streamed: false }));
  }
  const prom = (async () => {
    const tPath = await getChunkPath(fileId);
    const dl = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${tPath}`);
    if (!dl.ok || !dl.body) throw new Error("Téléchargement du morceau échoué");
    const safe = require("crypto").createHash("md5").update(fileId).digest("hex");
    const dest = pathMod.join(CHUNK_CACHE_DIR, safe + ".part");
    const tmp = dest + ".dl" + Math.random().toString(36).slice(2, 7);
    const ws = fsMod.createWriteStream(tmp);
    let size = 0, posIn = 0, streamed = !!res;
    for await (const piece of dl.body) {
      const b = Buffer.from(piece);
      if (!ws.write(b)) await new Promise(r => ws.once("drain", r));
      size += b.length;
      // Tee : alefa avy hatrany ny ampahany ilaina (misy backpressure)
      if (res && res.writable && winEnd >= 0) {
        const pStart = posIn, pEnd = posIn + b.length - 1;
        if (pEnd >= winStart && pStart <= winEnd) {
          const s0 = Math.max(0, winStart - pStart);
          const e0 = Math.min(b.length, winEnd - pStart + 1);
          if (!res.write(b.slice(s0, e0))) await new Promise(r => res.once("drain", r));
        }
      }
      posIn += b.length;
    }
    await new Promise((ok, ko) => ws.end(err => err ? ko(err) : ok()));
    try { fsMod.renameSync(tmp, dest); } catch {}
    chunkCacheIndex.set(fileId, { file: dest, size, ts: Date.now() });
    pruneChunkCache();
    return { file: dest, streamed };
  })().finally(() => chunkDownloads.delete(fileId));
  chunkDownloads.set(fileId, prom);
  return prom;
}

// Lecture : mandrafitra ny morceaux ho vidéo TOKANA (Range/seek — avy amin'ny cache disque)
app.get("/chunked", async (req, res) => {
  try {
    const ids = String(req.query.ids || "").split(",").filter(Boolean);
    const sizes = String(req.query.sizes || "").split(",").map(n => parseInt(n) || 0);
    const mime = String(req.query.mime || "video/mp4");
    if (!ids.length || ids.length !== sizes.length) return res.status(400).json({ error: "Paramètres invalides" });
    const totalSize = sizes.reduce((a, b) => a + b, 0);
    const offsets = []; let acc = 0;
    for (const sz of sizes) { offsets.push(acc); acc += sz; }

    const range = req.headers.range;
    let start = 0, end = totalSize - 1;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      if (m) { start = parseInt(m[1]) || 0; end = m[2] ? Math.min(parseInt(m[2]), totalSize - 1) : totalSize - 1; }
    }
    if (start >= totalSize) return res.status(416).end();

    res.writeHead(range ? 206 : 200, {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${totalSize}` } : {}),
      "Cache-Control": "public, max-age=86400",
    });

    let pos = start;
    for (let i = 0; i < ids.length && pos <= end; i++) {
      const cStart = offsets[i], cEnd = offsets[i] + sizes[i] - 1;
      if (cEnd < pos) continue;
      if (cStart > end) break;
      const readStart = pos - cStart;
      const readEnd = Math.min(end, cEnd) - cStart;
      // Préchargement ny morceaux 2 manaraka (arrière-plan) — lecture fluide
      if (i + 1 < ids.length && offsets[i + 1] <= end + 40 * 1024 * 1024) getChunkFile(ids[i + 1]).catch(() => {});
      // Tee : raha mbola tsy ao amin'ny cache dia alefa MIVANTANA eo am-pakana azy
      const got = await getChunkFile(ids[i], res, readStart, readEnd);
      if (!got.streamed) {
        await new Promise((ok, ko) => {
          const rs = fsMod.createReadStream(got.file, { start: readStart, end: readEnd });
          rs.on("error", ko);
          rs.on("end", ok);
          rs.pipe(res, { end: false });
          res.on("close", () => { rs.destroy(); ok(); });
        });
      }
      pos = Math.min(end, cEnd) + 1;
      if (!res.writable) return;
    }
    res.end();
  } catch (err) {
    console.error("chunked stream:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// Erreurs Multer et génériques -> toujours du JSON lisible par le frontend
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Fichier trop volumineux (max 300 Mo)" });
  }
  res.status(500).json({ error: err.message || "Erreur serveur" });
});



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

app.listen(PORT, () => console.log(`Traingo backend running on port ${PORT}`));
