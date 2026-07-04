process.chdir(__dirname);
const fs = require("fs");
let s = fs.readFileSync("server.js", "utf8");

// Manampy auto-route amin'ny /telegram/upload existing
const oldUpload = `router.post("/telegram/upload"`;
// Jereo ny endpoint upload existing
const hasRoute = s.includes("/telegram/upload");
console.log("Upload endpoint hita:", hasRoute);

// Manampy check size alohan'ny Bot API call
s = s.replace(
  /app\.post\(["']\/telegram\/upload["'],.*?upload\.single\(["']file["']\).*?,\s*async\s*\(req,\s*res\)\s*=>\s*\{/s,
  `app.post("/telegram/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  // Auto-route: video >= 19MB → GramJS
  if (req.file.size >= 19 * 1024 * 1024 && req.file.mimetype.startsWith("video")) {
    return handleGramUpload(req, res);
  }`
);

// Manampy handleGramUpload function raha tsy misy
if (!s.includes("async function handleGramUpload")) {
  s = s.replace(
    "app.post(\"/telegram/upload-large\"",
    `async function handleGramUpload(req, res) {
  try {
    if (!GRAM_CHANNEL) throw new Error("TELEGRAM_CHANNEL_ID not set");
    const client = await getGramClient();
    const isVideo = req.file.mimetype.startsWith("video");
    const result = await client.sendFile(GRAM_CHANNEL, {
      file: req.file.buffer, caption: "", workers: 4, forceDocument: !isVideo,
    });
    const BURL = process.env.BACKEND_URL || "https://tsengo-backend.onrender.com";
    res.json({ url: BURL + "/stream/" + result.id, messageId: result.id, type: isVideo ? "video" : "file" });
  } catch(err) {
    console.error("GramJS upload error:", err.message);
    res.status(500).json({ error: "GramJS: " + err.message });
  }
}

app.post("/telegram/upload-large"`
  );
}

fs.writeFileSync("server.js", s);
console.log("Patch2 vita!");
