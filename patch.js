process.chdir(__dirname);
const fs = require("fs");
let s = fs.readFileSync("server.js", "utf8");

// 1. Manampy GramJS imports aorian'ny FormData require
const gramImports = `
const GRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || "0");
const GRAM_API_HASH = process.env.TELEGRAM_API_HASH || "";
const GRAM_SESSION = process.env.TELEGRAM_SESSION || "";
const GRAM_CHANNEL = process.env.TELEGRAM_CHANNEL_ID || "";
let TelegramClient, StringSession, Api;
let gramClient = null;
let gramReady = false;
try {
  ({ TelegramClient } = require("telegram"));
  ({ StringSession } = require("telegram/sessions"));
  ({ Api } = require("telegram"));
  gramReady = true;
  console.log("GramJS loaded");
} catch(e) { console.log("GramJS not installed"); }
async function getGramClient() {
  if (!gramReady) throw new Error("GramJS not installed");
  if (!GRAM_API_ID || !GRAM_API_HASH || !GRAM_SESSION) throw new Error("Missing GRAM env vars");
  if (gramClient && gramClient.connected) return gramClient;
  const client = new TelegramClient(new StringSession(GRAM_SESSION), GRAM_API_ID, GRAM_API_HASH, { connectionRetries: 5 });
  await client.connect();
  gramClient = client;
  console.log("GramJS connected");
  return client;
}`;

s = s.replace(
  'const FormData = require("form-data");',
  'const FormData = require("form-data");\n' + gramImports
);

// 2. Multer 500MB
s = s.replace(
  /fileSize:\s*\d+\s*\*\s*\d+\s*\*\s*\d+/,
  "fileSize: 500 * 1024 * 1024"
);

// 3. Self-ping + /ping endpoint
const pingCode = `
app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));
const BACKEND_URL = process.env.BACKEND_URL || "https://tsengo-backend.onrender.com";
setInterval(async () => {
  try { await fetch(BACKEND_URL + "/ping"); console.log("Self-ping OK"); }
  catch(e) { console.log("Self-ping failed"); }
}, 14 * 60 * 1000);
`;
s = s.replace(
  'app.get("/"',
  pingCode + '\napp.get("/"'
);

// 4. GramJS stream endpoint + large upload - ampidiro alohan'ny app.listen
const gramEndpoints = `
app.post("/telegram/upload-large", require("multer")({ storage: require("multer").memoryStorage(), limits: { fileSize: 500*1024*1024 } }).single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  try {
    if (!GRAM_CHANNEL) throw new Error("TELEGRAM_CHANNEL_ID not set");
    const client = await getGramClient();
    const isVideo = req.file.mimetype.startsWith("video");
    const result = await client.sendFile(GRAM_CHANNEL, {
      file: req.file.buffer,
      caption: "",
      workers: 4,
      forceDocument: !isVideo,
    });
    res.json({
      url: (process.env.BACKEND_URL || "https://tsengo-backend.onrender.com") + "/stream/" + result.id,
      messageId: result.id,
      type: isVideo ? "video" : "file",
    });
  } catch(err) {
    console.error("GramJS upload error:", err);
    res.status(500).json({ error: "GramJS: " + err.message });
  }
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
      const m = range.match(/bytes=(\\d+)-(\\d*)/);
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
`;

s = s.replace(
  /app\.listen\(/,
  gramEndpoints + "\napp.listen("
);

fs.writeFileSync("server.js", s);
console.log("Patch vita!");
