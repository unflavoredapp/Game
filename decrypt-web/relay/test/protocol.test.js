import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

const OPERATOR = "op-secret";
const NODE = "node-secret";

describe("Decrypt Web protocol v0", () => {
  /** @type {string} */
  let dataDir;
  /** @type {Store} */
  let store;
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"));
    store = new Store(dataDir, { leaseSeconds: 60, onlineWindowMs: 60_000 });
    const app = createApp({ store, operatorToken: OPERATOR, nodeToken: NODE });
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function op(pathname, init = {}) {
    const headers = {
      "X-Decrypt-Operator-Token": OPERATOR,
      ...(init.headers || {}),
    };
    return fetch(`${base}${pathname}`, { ...init, headers });
  }

  async function node(pathname, init = {}) {
    const headers = {
      "X-Decrypt-Node-Token": NODE,
      ...(init.headers || {}),
    };
    return fetch(`${base}${pathname}`, { ...init, headers });
  }

  it("health is public", async () => {
    const res = await fetch(`${base}/v0/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.protocol, "decrypt-web");
    assert.equal(body.version, "0.0");
    assert.equal(body.site, "decrypt.software");
  });

  it("rejects missing operator token", async () => {
    const res = await fetch(`${base}/v0/jobs`);
    assert.equal(res.status, 401);
  });

  it("runs enqueue → hello → claim → progress → complete", async () => {
    const created = await op("/v0/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://apps.apple.com/us/app/id1",
        country: "us",
        constraints: { backends: ["buddy3"] },
      }),
    });
    assert.equal(created.status, 201);
    const job = await created.json();
    assert.equal(job.status, "queued");

    const hello = await node("/v0/node/hello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "phone-1",
        countries: ["us"],
        capabilities: { backends: ["buddy3"], jailbreak: "dopamine" },
      }),
    });
    assert.equal(hello.status, 200);

    const claim = await node("/v0/node/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "phone-1", countries: ["us"] }),
    });
    assert.equal(claim.status, 200);
    const claimed = await claim.json();
    assert.equal(claimed.job.id, job.id);
    assert.equal(claimed.job.url, job.url);

    const progress = await node("/v0/node/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "phone-1",
        jobId: job.id,
        stage: "decrypt",
        percent: 55,
        message: "buddy3",
      }),
    });
    assert.equal(progress.status, 200);

    const payload = Buffer.from("IPA-BYTES");
    const complete = await node(
      `/v0/node/complete?jobId=${encodeURIComponent(job.id)}&name=${encodeURIComponent("app.ipa")}&nodeId=phone-1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload,
      }
    );
    assert.equal(complete.status, 200);
    const done = await complete.json();
    assert.equal(done.job.status, "done");
    assert.equal(done.job.artifact.bytes, payload.length);
    assert.ok(done.job.artifact.sha256);

    // idempotent complete
    const again = await node(
      `/v0/node/complete?jobId=${encodeURIComponent(job.id)}&name=app.ipa&nodeId=phone-1`,
      { method: "POST", body: payload }
    );
    assert.equal(again.status, 200);
    const nodes = await (await op("/v0/nodes")).json();
    const n = nodes.nodes.find((x) => x.id === "phone-1");
    assert.equal(n.jobsDone, 1);

    const art = await op(`/v0/artifacts/${job.id}`);
    assert.equal(art.status, 200);
    const bytes = Buffer.from(await art.arrayBuffer());
    assert.deepEqual(bytes, payload);
  });

  it("routes by country and backend capability", async () => {
    await op("/v0/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://apps.apple.com/in/app/id2",
        country: "in",
        constraints: { backends: ["buddy3"] },
      }),
    });

    await node("/v0/node/hello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "us-only",
        countries: ["us"],
        capabilities: { backends: ["buddy3"] },
      }),
    });

    const miss = await node("/v0/node/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "us-only", countries: ["us"] }),
    });
    assert.equal((await miss.json()).job, null);

    await node("/v0/node/hello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "in-node",
        countries: ["in"],
        capabilities: { backends: ["buddy3"] },
      }),
    });
    const hit = await node("/v0/node/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "in-node", countries: ["in"] }),
    });
    const body = await hit.json();
    assert.equal(body.job.country, "in");
  });

  it("requeues after lease expiry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-lease-"));
    const s = new Store(dir, { leaseSeconds: 1, maxRequeues: 5 });
    s.hello({ id: "n1", countries: ["us"], capabilities: { backends: [] } });
    const job = s.enqueue("https://apps.apple.com/us/app/id3", "us");
    const claimed = s.claim({ id: "n1", countries: ["us"] });
    assert.equal(claimed.job.id, job.id);
    // force expiry
    const held = s.getJob(job.id);
    held.lease.expiresAt = Date.now() - 1;
    s.save();
    const again = s.claim({ id: "n1", countries: ["us"] });
    assert.equal(again.job.id, job.id);
    assert.equal(s.getJob(job.id).requeues, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
