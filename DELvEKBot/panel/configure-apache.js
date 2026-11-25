#!/usr/bin/env node
"use strict";
const fs = require("fs");
const snippet = `
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass /api/ http://127.0.0.1:3000/api/
    ProxyPassReverse /api/ http://127.0.0.1:3000/api/
    ProxyPass /health http://127.0.0.1:3000/health
    ProxyPassReverse /health http://127.0.0.1:3000/health
    ProxyPass /panel.css http://127.0.0.1:3000/panel.css
    ProxyPassReverse /panel.css http://127.0.0.1:3000/panel.css
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
    LimitRequestBody 0
    ProxyTimeout 1800
`;
const candidates = [
  "/etc/apache2/sites-available/delvek.bot-le-ssl.conf",
  "/etc/apache2/sites-available/delvek.bot.conf",
];
let updated = false;
for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  let text = fs.readFileSync(file, "utf8");
  text = text.replaceAll("127.0.0.1:8080", "127.0.0.1:3000");
  if (!text.includes("ProxyPass /api/")) {
    text = text.replace("</VirtualHost>", `${snippet}\n</VirtualHost>`);
  } else if (!text.includes("ProxyPass / http://127.0.0.1:3000/")) {
    text = text.replace(
      "ProxyPass /api/ http://127.0.0.1:3000/api/",
      "ProxyPass /api/ http://127.0.0.1:3000/api/\n    ProxyPass / http://127.0.0.1:3000/\n    ProxyPassReverse / http://127.0.0.1:3000/"
    );
  }
  fs.writeFileSync(file, text);
  console.log(`Updated ${file}`);
  updated = true;
  break;
}
if (!updated) {
  const conf = "/etc/apache2/sites-available/delvek.bot.conf";
  fs.writeFileSync(conf, `<VirtualHost *:80>\n    ServerName delvek.bot\n    ServerAlias www.delvek.bot\n${snippet}\n</VirtualHost>\n`);
  console.log(`Wrote ${conf}`);
}
