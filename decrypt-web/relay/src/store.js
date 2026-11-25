import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function now() {
  return Date.now();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeCountry(c) {
  return String(c || "us").toLowerCase().slice(0, 2);
}

function normalizeCountries(list) {
  if (!Array.isArray(list) || list.length === 0) return ["us"];
  return [...new Set(list.map(normalizeCountry))];
}

function backendsOf(caps) {
  const b = caps && Array.isArray(caps.backends) ? caps.backends : [];
  return b.map((x) => String(x).toLowerCase());
}

function jobMatchesNode(job, nodeCountries, nodeCaps) {
  const countries = new Set(normalizeCountries(nodeCountries));
  if (!countries.has(job.country)) return false;
  const required = job.constraints?.backends;
  if (!required || !required.length) return true;
  const have = new Set(backendsOf(nodeCaps));
  return required.some((b) => have.has(String(b).toLowerCase()));
}

export class Store {
  /**
   * @param {string} dataDir
   * @param {{ leaseSeconds?: number, onlineWindowMs?: number, maxRequeues?: number }} [opts]
   */
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir;
    this.artifactDir = path.join(dataDir, "artifacts");
    this.dbPath = path.join(dataDir, "state.json");
    this.leaseSeconds = opts.leaseSeconds ?? 900;
    this.onlineWindowMs = opts.onlineWindowMs ?? 120_000;
    this.maxRequeues = opts.maxRequeues ?? 5;
    ensureDir(this.artifactDir);
    this.state = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.dbPath)) {
      return { jobs: [], nodes: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(this.dbPath, "utf8"));
    } catch {
      return { jobs: [], nodes: {} };
    }
  }

  save() {
    ensureDir(this.dataDir);
    const tmp = `${this.dbPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.dbPath);
  }

  health() {
    return {
      ok: true,
      protocol: "decrypt-web",
      version: "0.0",
      site: "decrypt.software",
    };
  }

  enqueue(url, country = "us", constraints = {}) {
    const job = {
      id: randomUUID(),
      url: String(url).trim(),
      country: normalizeCountry(country),
      status: "queued",
      constraints: constraints && typeof constraints === "object" ? constraints : {},
      progress: null,
      artifact: null,
      error: null,
      lease: null,
      requeues: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.jobs.unshift(job);
    this.save();
    return job;
  }

  listJobs(limit = 50) {
    this.#expireLeases();
    return this.state.jobs.slice(0, Math.min(200, Math.max(1, limit)));
  }

  getJob(id) {
    this.#expireLeases();
    return this.state.jobs.find((j) => j.id === id) || null;
  }

  listNodes() {
    this.#expireLeases();
    const t = now();
    return Object.values(this.state.nodes).map((n) => this.#publicNode(n, t));
  }

  hello(body) {
    const id = String(body?.id || "").trim();
    if (!id) throw Object.assign(new Error("id required"), { status: 400 });
    const existing = this.state.nodes[id] || {
      id,
      jobsDone: 0,
      jobsFailed: 0,
      activeJobId: null,
    };
    const node = {
      ...existing,
      id,
      countries: normalizeCountries(body.countries),
      capabilities:
        body.capabilities && typeof body.capabilities === "object"
          ? body.capabilities
          : { backends: [] },
      freeBytes: body.freeBytes ?? null,
      totalBytes: body.totalBytes ?? null,
      lastSeenAt: now(),
    };
    this.state.nodes[id] = node;
    this.save();
    return { node: this.#publicNode(node), leaseSeconds: this.leaseSeconds };
  }

  claim(body) {
    this.#expireLeases();
    const id = String(body?.id || "").trim();
    if (!id) throw Object.assign(new Error("id required"), { status: 400 });

    const node = this.state.nodes[id];
    if (!node) {
      throw Object.assign(new Error("node must hello first"), { status: 400 });
    }

    const countries = body.countries ? normalizeCountries(body.countries) : node.countries;
    node.countries = countries;
    node.lastSeenAt = now();

    if (node.activeJobId) {
      const held = this.state.jobs.find((j) => j.id === node.activeJobId);
      if (held && held.status === "leased" && held.lease?.nodeId === id) {
        this.save();
        return { job: this.#leasePayload(held) };
      }
      node.activeJobId = null;
    }

    const job = this.state.jobs.find(
      (j) => j.status === "queued" && jobMatchesNode(j, countries, node.capabilities)
    );
    if (!job) {
      this.save();
      return { job: null };
    }

    const expiresAt = now() + this.leaseSeconds * 1000;
    job.status = "leased";
    job.lease = { nodeId: id, expiresAt };
    job.progress = { stage: "claimed", percent: 5, message: "claimed" };
    job.updatedAt = now();
    node.activeJobId = job.id;
    this.save();
    return { job: this.#leasePayload(job) };
  }

  progress(body) {
    const { node, job } = this.#requireLease(body);
    node.lastSeenAt = now();
    job.lease.expiresAt = now() + this.leaseSeconds * 1000;
    const percent = Number.isFinite(body.percent) ? Number(body.percent) : job.progress?.percent || 10;
    job.progress = {
      stage: String(body.stage || job.progress?.stage || "working"),
      percent: Math.max(0, Math.min(99, percent)),
      message: String(body.message || ""),
    };
    job.updatedAt = now();
    this.save();
    return { ok: true, job };
  }

  fail(body) {
    const { node, job } = this.#requireLease(body);
    job.status = "failed";
    job.error = String(body.error || "failed");
    job.lease = null;
    job.progress = {
      stage: "failed",
      percent: job.progress?.percent || 0,
      message: job.error,
    };
    job.updatedAt = now();
    node.activeJobId = null;
    node.lastSeenAt = now();
    node.jobsFailed = (node.jobsFailed || 0) + 1;
    this.save();
    return { ok: true, job };
  }

  /**
   * Idempotent: repeating complete for an already-done job returns success
   * without double-counting jobsDone.
   * @param {{ id: string, jobId: string, name: string, buffer: Buffer, contentType?: string, sha256?: string }} args
   */
  complete(args) {
    this.#expireLeases();
    const job = this.state.jobs.find((j) => j.id === args.jobId);
    if (!job) throw Object.assign(new Error("job not found"), { status: 404 });

    if (job.status === "done") {
      const node = this.state.nodes[args.id];
      if (node) node.lastSeenAt = now();
      this.save();
      return { ok: true, job };
    }

    const { node } = this.#requireLease({ id: args.id, jobId: args.jobId });

    const name = String(args.name || "artifact.bin").replace(/[/\\]/g, "_");
    const dest = path.join(this.artifactDir, `${job.id}-${name}`);
    fs.writeFileSync(dest, args.buffer);

    const sha256 =
      args.sha256 || createHash("sha256").update(args.buffer).digest("hex");

    job.status = "done";
    job.error = null;
    job.lease = null;
    job.progress = { stage: "done", percent: 100, message: "complete" };
    job.artifact = {
      name,
      bytes: args.buffer.length,
      contentType: args.contentType || "application/octet-stream",
      sha256,
      downloadPath: `/v0/artifacts/${job.id}`,
    };
    job.updatedAt = now();
    node.activeJobId = null;
    node.lastSeenAt = now();
    node.jobsDone = (node.jobsDone || 0) + 1;
    this.save();
    return { ok: true, job };
  }

  artifactPath(jobId) {
    const job = this.getJob(jobId);
    if (!job || job.status !== "done" || !job.artifact) return null;
    const p = path.join(this.artifactDir, `${job.id}-${job.artifact.name}`);
    if (!fs.existsSync(p)) return null;
    return { path: p, job };
  }

  #requireLease(body) {
    this.#expireLeases();
    const id = String(body?.id || "").trim();
    const jobId = String(body?.jobId || "").trim();
    if (!id || !jobId) {
      throw Object.assign(new Error("id and jobId required"), { status: 400 });
    }
    const node = this.state.nodes[id];
    if (!node) throw Object.assign(new Error("unknown node"), { status: 400 });
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job) throw Object.assign(new Error("job not found"), { status: 404 });
    if (job.status !== "leased" || job.lease?.nodeId !== id) {
      throw Object.assign(new Error("lease conflict"), { status: 409 });
    }
    if (job.lease.expiresAt < now()) {
      throw Object.assign(new Error("lease expired"), { status: 409 });
    }
    return { node, job };
  }

  #expireLeases() {
    const t = now();
    let dirty = false;
    for (const job of this.state.jobs) {
      if (job.status !== "leased" || !job.lease) continue;
      if (job.lease.expiresAt >= t) continue;
      const node = this.state.nodes[job.lease.nodeId];
      if (node && node.activeJobId === job.id) node.activeJobId = null;
      job.requeues = (job.requeues || 0) + 1;
      if (job.requeues > this.maxRequeues) {
        job.status = "failed";
        job.error = "lease expired too many times";
        job.lease = null;
      } else {
        job.status = "queued";
        job.lease = null;
        job.progress = { stage: "requeued", percent: 0, message: "lease expired" };
      }
      job.updatedAt = t;
      dirty = true;
    }
    if (dirty) this.save();
  }

  #leasePayload(job) {
    return {
      id: job.id,
      url: job.url,
      country: job.country,
      constraints: job.constraints || {},
    };
  }

  #publicNode(node, t = now()) {
    let status = "offline";
    if (t - (node.lastSeenAt || 0) <= this.onlineWindowMs) {
      status = node.activeJobId ? "busy" : "online";
    }
    return {
      id: node.id,
      status,
      countries: node.countries || [],
      capabilities: node.capabilities || { backends: [] },
      freeBytes: node.freeBytes ?? null,
      totalBytes: node.totalBytes ?? null,
      activeJobId: node.activeJobId || null,
      lastSeenAt: node.lastSeenAt || 0,
      jobsDone: node.jobsDone || 0,
      jobsFailed: node.jobsFailed || 0,
    };
  }
}
