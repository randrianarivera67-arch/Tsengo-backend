const fs = require("fs");
const content = fs.readFileSync(__filename, "utf8");
const start = content.indexOf("/*SERVER_START*/") + 16;
const end = content.indexOf("/*SERVER_END*/");
fs.writeFileSync(__dirname + "/server.js", content.slice(start, end));
console.log("✅ server.js écrit!");
