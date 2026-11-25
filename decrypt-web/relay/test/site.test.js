import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { startDemoNode } from "../src/demoNode.js";

const OPERATOR = "op-site";
const NODE = "node-site";

describe("getipa.fast site + demo node", () => {
  let dataDir;
  let store;
  let server;
  let base;
  let stopDemo;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-site-"));
    store = new Store(dataDir, { leaseSeconds: 60 });
    const app = createApp({ store, operatorToken: OPERATOR, nodeToken: NODE });
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address();
    base = `http://127.0.0.1:${port}`;
    stopDemo = startDemoNode({ baseUrl: base, nodeToken: NODE, nodeId: "site-demo" });
  });

  after(async () => {
    stopDemo?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("serves the landing page", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /getipa\.fast/);
    assert.match(html, /Get an IPA/);
  });

  it("demo node completes a queued job", async () => {
    const created = await fetch(`${base}/v0/jobs`, {
      method: "POST",
      headers: {
        "X-Decrypt-Operator-Token": OPERATOR,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://apps.apple.com/us/app/id999",
        country: "us",
        constraints: { backends: ["demo"] },
      }),
    });
    assert.equal(created.status, 201);
    const job = await created.json();

    let done = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const got = await fetch(`${base}/v0/jobs/${job.id}`, {
        headers: { "X-Decrypt-Operator-Token": OPERATOR },
      });
      done = await got.json();
      if (done.status === "done") break;
    }
    assert.equal(done.status, "done");
    assert.ok(done.artifact?.bytes > 0);

    const art = await fetch(`${base}/v0/artifacts/${job.id}`, {
      headers: { "X-Decrypt-Operator-Token": OPERATOR },
    });
    assert.equal(art.status, 200);
    const text = await art.text();
    assert.match(text, /getipa\.fast demo artifact/);
  });
});
