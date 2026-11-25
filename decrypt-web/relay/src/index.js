import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 3040);
const dataDir =
  process.env.DECRYPT_WEB_DATA || path.join(os.homedir(), ".decrypt-web", "data");
const operatorToken = process.env.OPERATOR_TOKEN || "";
const nodeToken = process.env.NODE_TOKEN || "";

if (!operatorToken || !nodeToken) {
  console.error("Set OPERATOR_TOKEN and NODE_TOKEN in the environment or .env");
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });

const store = new Store(dataDir, {
  leaseSeconds: Number(process.env.LEASE_SECONDS || 900),
  onlineWindowMs: Number(process.env.ONLINE_WINDOW_MS || 120_000),
  maxRequeues: Number(process.env.MAX_REQUEUES || 5),
});

const app = createApp({ store, operatorToken, nodeToken });

app.listen(port, () => {
  console.log(`Decrypt Web relay v0 listening on http://127.0.0.1:${port}`);
  console.log(`data: ${dataDir}`);
});
