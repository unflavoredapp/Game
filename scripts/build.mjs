import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const www = join(root, "www");

mkdirSync(www, { recursive: true });
mkdirSync(join(www, "assets"), { recursive: true });

// Ensure icons exist in www (already authored there)
const iconSrc = join(root, "resources", "icon-1024.png");
if (existsSync(iconSrc)) {
  cpSync(iconSrc, join(www, "assets", "icon-512.png"));
}

const manifest = {
  name: "Signal Loft",
  short_name: "Signal Loft",
  description: "One room. Infinite jobs. Every action has a consequence.",
  start_url: ".",
  display: "standalone",
  background_color: "#0c0a09",
  theme_color: "#0c0a09",
  orientation: "portrait",
  icons: [
    {
      src: "assets/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ],
};

writeFileSync(join(www, "manifest.webmanifest"), JSON.stringify(manifest, null, 2));

const indexPath = join(www, "index.html");
if (!existsSync(indexPath)) {
  console.error("Missing www/index.html");
  process.exit(1);
}

// Stamp build meta for debugging IPA web bundle
const html = readFileSync(indexPath, "utf8");
if (!html.includes("data-build=")) {
  writeFileSync(
    indexPath,
    html.replace("<html", `<html data-build="${new Date().toISOString()}"`),
  );
}

console.log("Signal Loft web bundle ready in www/");
