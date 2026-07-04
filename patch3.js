process.chdir(__dirname);
const fs = require("fs");
let s = fs.readFileSync("server.js", "utf8");

const gramInit = `
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
`;

// Ampidiro aorian'ny require farany
s = s.replace(
  /const PORT = process\.env\.PORT/,
  gramInit + "\nconst PORT = process.env.PORT"
);

fs.writeFileSync("server.js", s);
console.log("Patch3 vita! Lines:", s.split("\n").length);
