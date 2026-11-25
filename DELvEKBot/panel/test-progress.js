#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("./store");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delvekbot-progress-"));
const store = new Store(dir);

const job = store.enqueue("https://apps.apple.com/us/app/x/id1", "us");
assert.strictEqual(job.percent, 0);
assert.strictEqual(job.stage, "queued");

const claimed = store.claim("default-phone", 60_000, ["us"]);
assert.strictEqual(claimed.id, job.id);
assert.strictEqual(claimed.percent, 5);

store.progress(job.id, "resolving listing", 60_000, 10, "resolve");
assert.strictEqual(store.getJob(job.id).percent, 10);
assert.strictEqual(store.getJob(job.id).stage, "resolve");

store.progress(job.id, "DELvEKBot · worker active; decrypt still running (55%)", 60_000);
assert.strictEqual(store.getJob(job.id).percent, 55);
assert.strictEqual(store.getJob(job.id).stage, "decrypt");

// Heartbeat must not move percent backwards.
store.progress(job.id, "still running", 60_000, 20, "decrypt");
assert.strictEqual(store.getJob(job.id).percent, 55);

store.complete(job.id, {
  name: "Demo",
  buffer: Buffer.from("ipa"),
  phoneId: "default-phone",
  startedAt: Date.now() - 1000,
});
assert.strictEqual(store.getJob(job.id).percent, 100);
assert.strictEqual(store.getJob(job.id).stage, "complete");

const job2 = store.enqueue("https://apps.apple.com/us/app/y/id2", "us");
store.claim("default-phone", 60_000, ["us"]);
store.progress(job2.id, "uploading", 60_000, 80, "upload");
const phones = store.listPhones();
assert.strictEqual(phones.length, 1);
assert.strictEqual(phones[0].jobsDone, 1);
assert.ok(phones[0].activeJob);
assert.strictEqual(phones[0].activeJob.percent, 80);
assert.strictEqual(phones[0].activeJob.stage, "upload");
assert.strictEqual(phones[0].successRate, 100);

fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS progress percent + stage + phones");
