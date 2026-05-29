const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const readline = require("readline");
const API_ID = parseInt(process.env.TELEGRAM_API_ID || "0");
const API_HASH = process.env.TELEGRAM_API_HASH || "";
if (!API_ID || !API_HASH) { console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH!"); process.exit(1); }
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((r) => rl.question(q, r));
async function main() {
  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => await question("Phone (+261...): "),
    password: async () => await question("2FA password (Enter raha tsy misy): "),
    phoneCode: async () => await question("OTP code: "),
    onError: (err) => console.error(err),
  });
  console.log("\n✅ TELEGRAM_SESSION=" + client.session.save());
  await client.disconnect();
  rl.close();
}
main().catch(console.error);
