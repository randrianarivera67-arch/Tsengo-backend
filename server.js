const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");

const app = express();
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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

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

app.use(cors({
  origin: [FRONTEND_URL, "https://tsengo.vercel.app", "http://localhost:5173"],
}));
app.use(express.json({ limit: "10kb" }));

app.get("/", (req, res) => {
  res.json({ status: "Tsengo Backend OK 🌸", version: "6.0.0" });
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
  const title = req.body.title || `Tsengo_${Date.now()}`;

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
          snippet: { title, description: "Partagé via Tsengo", categoryId: "22" },
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
      body: req.file.buffer,
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

// ✅ PROXY via file_id (fichiers > 20MB — getFile via bot puis stream)
app.get("/media-id", async (req, res) => {
  const { file_id } = req.query;
  if (!file_id || !BOT_TOKEN) return res.status(400).json({ error: "Missing file_id or token" });
  try {
    // Essayer getFile d'abord (marche pour < 20MB)
    const fRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${file_id}`);
    const fData = await fRes.json();
    if (fData.ok && fData.result.file_path) {
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fData.result.file_path}`;
      const r = await fetch(url);
      if (!r.ok) return res.status(404).json({ error: "File not found" });
      const ct = r.headers.get("content-type") || "application/octet-stream";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "public, max-age=31536000");
      return r.body.pipe(res);
    }
    // Fichier > 20MB — utiliser bot local download API
    const dlRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${file_id}`);
    const dlData = await dlRes.json();
    if (!dlData.ok) return res.status(404).json({ error: "Cannot get file: " + dlData.description });
    res.status(400).json({ error: "File too large for Telegram API (>20MB)" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ OneSignal notify
app.post("/notify", async (req, res) => {
  if (NOTIFY_SECRET && req.headers["x-notify-secret"] !== NOTIFY_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { toExternalId, title, message, data, fromPhoto } = req.body;
  if (!toExternalId || !title || !message) {
    return res.status(400).json({ error: "toExternalId, title, message required" });
  }
  if (!ONESIGNAL_REST_API_KEY) {
    return res.status(500).json({ error: "ONESIGNAL_REST_API_KEY not configured" });
  }
  const notifType = data?.type || "general";
  const conversationId = data?.conversationId || "";
  const postId = data?.postId || "";
  let url = FRONTEND_URL;
  if (notifType === "message" && conversationId) url = `${FRONTEND_URL}/messages/${conversationId}`;
  else if (["post","like","reaction","comment"].includes(notifType)) url = `${FRONTEND_URL}/post/${postId}`;
  else if (["follow","friendRequest"].includes(notifType)) url = `${FRONTEND_URL}/profile/${toExternalId}`;
  const isMessage = notifType === "message";
  const buttons = isMessage
    ? [{ id: "reply", text: "Répondre" }, { id: "close", text: "Fermer" }]
    : [{ id: "view", text: "Voir" }, { id: "close", text: "Fermer" }];
  try {
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}` },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_external_user_ids: [toExternalId],
        headings: { en: title },
        contents: { en: message },
        url,
        chrome_web_icon: fromPhoto || `${FRONTEND_URL}/icon-192.png`,
        large_icon: fromPhoto && fromPhoto.startsWith('https') ? fromPhoto : `${FRONTEND_URL}/icon-192.png`,
        small_icon: 'tsengo_icon',
        chrome_web_badge: `${FRONTEND_URL}/icon-192.png`,
        android_accent_color: 'FFE91E8C',
        android_led_color: 'FFE91E8C',
        web_buttons: buttons,
        buttons,
      }),
    });
    const result = await response.json();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Tsengo backend running on port ${PORT}`));

// ✅ Telegram — Upload video lehibe (hatramin'ny 2GB)
app.post("/telegram/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const form = new (require('form-data'))();
    form.append('chat_id', process.env.TELEGRAM_CHAT_ID);
    form.append('document', req.file.buffer, { filename: req.file.originalname || 'video.mp4', contentType: req.file.mimetype });
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form, headers: form.getHeaders() });
    const data = await r.json();
    if (!data.ok) return res.status(500).json({ error: data.description });
    const fileId = data.result.document?.file_id || data.result.video?.file_id;
    const fRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fData = await fRes.json();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fData.result.file_path}`;
    res.json({ url, fileId, type: req.file.mimetype.startsWith('video') ? 'video' : 'image' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
