const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

function now() {
  return Date.now();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.ipaDir = path.join(dataDir, "ipas");
    this.dbPath = path.join(dataDir, "state.json");
    ensureDir(this.ipaDir);
    this.state = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.dbPath)) {
      return { jobs: [], phones: {}, transfers: [] };
    }
    try {
      return JSON.parse(fs.readFileSync(this.dbPath, "utf8"));
    } catch {
      return { jobs: [], phones: {}, transfers: [] };
    }
  }

  save() {
    ensureDir(this.dataDir);
    const tmp = `${this.dbPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.dbPath);
  }

  enqueue(url) {
    const job = {
      id: randomUUID(),
      url: String(url).trim(),
      status: "queued",
      error: null,
      progress: null,
      name: null,
      ipaPath: null,
      ipaBytes: 0,
      leaseExpiresAt: null,
      phoneId: null,
      createdAt: now(),
      updatedAt: now(),
      upload: null,
      telegram: null,
    };
    this.state.jobs.unshift(job);
    this.save();
    return job;
  }

  listJobs(limit = 100) {
    this.reapExpired();
    return this.state.jobs.slice(0, limit);
  }

  getJob(id) {
    return this.state.jobs.find((j) => j.id === id) || null;
  }

  touchPhone(phoneId, patch = {}) {
    const id = phoneId || "default-phone";
    const prev = this.state.phones[id] || {
      id,
      firstSeenAt: now(),
      jobsDone: 0,
      bytesIn: 0,
    };
    this.state.phones[id] = {
      ...prev,
      ...patch,
      id,
      lastSeenAt: now(),
    };
    this.save();
    return this.state.phones[id];
  }

  listPhones() {
    return Object.values(this.state.phones).sort(
      (a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0)
    );
  }

  reapExpired() {
    const t = now();
    let changed = false;
    for (const job of this.state.jobs) {
      if (
        job.status === "leased" &&
        job.leaseExpiresAt &&
        job.leaseExpiresAt < t
      ) {
        job.status = "queued";
        job.leaseExpiresAt = null;
        job.phoneId = null;
        job.progress = "lease expired · requeued";
        job.updatedAt = t;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  claim(phoneId, leaseMs) {
    this.reapExpired();
    const job = this.state.jobs
      .filter((j) => j.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return null;
    job.status = "leased";
    job.phoneId = phoneId || "default-phone";
    job.leaseExpiresAt = now() + leaseMs;
    job.progress = "claimed";
    job.updatedAt = now();
    this.touchPhone(job.phoneId, { status: "busy", activeJobId: job.id });
    this.save();
    return job;
  }

  progress(id, msg, leaseMs) {
    const job = this.getJob(id);
    if (!job || job.status !== "leased") return null;
    job.progress = msg;
    job.leaseExpiresAt = now() + leaseMs;
    job.updatedAt = now();
    if (job.phoneId) this.touchPhone(job.phoneId, { status: "busy", activeJobId: job.id });
    this.save();
    return job;
  }

  fail(id, error) {
    const job = this.getJob(id);
    if (!job || job.status !== "leased") return null;
    job.status = "failed";
    job.error = error || "failed";
    job.leaseExpiresAt = null;
    job.updatedAt = now();
    if (job.phoneId) {
      this.touchPhone(job.phoneId, { status: "online", activeJobId: null, lastError: job.error });
    }
    this.save();
    return job;
  }

  complete(id, { name, buffer, phoneId, startedAt }) {
    const job = this.getJob(id);
    if (!job || (job.status !== "leased" && job.status !== "done")) return null;

    const endedAt = now();
    const durationMs = Math.max(1, endedAt - (startedAt || endedAt));
    const bytes = buffer.length;
    const mbps = (bytes * 8) / (durationMs / 1000) / 1_000_000;
    const safe = String(name || id)
      .replace(/[^\w.\- ]+/g, "_")
      .slice(0, 120);
    const ipaPath = path.join(this.ipaDir, `${id}_${safe}.ipa`);
    fs.writeFileSync(ipaPath, buffer);

    job.status = "done";
    job.name = name || safe;
    job.ipaPath = ipaPath;
    job.ipaBytes = bytes;
    job.leaseExpiresAt = null;
    job.error = null;
    job.progress = "complete";
    job.updatedAt = endedAt;
    job.upload = {
      bytes,
      durationMs,
      mbps: Number(mbps.toFixed(3)),
      at: endedAt,
    };

    const pid = phoneId || job.phoneId || "default-phone";
    const phone = this.touchPhone(pid, { status: "online", activeJobId: null });
    phone.jobsDone = (phone.jobsDone || 0) + 1;
    phone.bytesIn = (phone.bytesIn || 0) + bytes;

    this.state.transfers.unshift({
      id: randomUUID(),
      jobId: id,
      kind: "phone_to_vps",
      bytes,
      durationMs,
      mbps: job.upload.mbps,
      at: endedAt,
      phoneId: pid,
      name: job.name,
    });
    this.state.transfers = this.state.transfers.slice(0, 200);
    this.save();
    return job;
  }

  recordTelegramTransfer(jobId, { bytes, durationMs, ok, error }) {
    const mbps = (bytes * 8) / (Math.max(1, durationMs) / 1000) / 1_000_000;
    const job = this.getJob(jobId);
    const entry = {
      bytes,
      durationMs,
      mbps: Number(mbps.toFixed(3)),
      ok: !!ok,
      error: error || null,
      at: now(),
    };
    if (job) {
      job.telegram = entry;
      job.updatedAt = now();
    }
    this.state.transfers.unshift({
      id: randomUUID(),
      jobId,
      kind: "vps_to_telegram",
      ...entry,
      name: job?.name || null,
    });
    this.state.transfers = this.state.transfers.slice(0, 200);
    this.save();
    return entry;
  }

  stats() {
    this.reapExpired();
    const jobs = this.state.jobs;
    const transfers = this.state.transfers || [];
    const recent = transfers.slice(0, 20);
    const avg = (kind) => {
      const rows = transfers.filter((t) => t.kind === kind && t.mbps > 0).slice(0, 20);
      if (!rows.length) return 0;
      return Number(
        (rows.reduce((s, t) => s + t.mbps, 0) / rows.length).toFixed(3)
      );
    };
    return {
      counts: {
        queued: jobs.filter((j) => j.status === "queued").length,
        leased: jobs.filter((j) => j.status === "leased").length,
        done: jobs.filter((j) => j.status === "done").length,
        failed: jobs.filter((j) => j.status === "failed").length,
        phones: Object.keys(this.state.phones).length,
      },
      avgMbps: {
        phoneToVps: avg("phone_to_vps"),
        vpsToTelegram: avg("vps_to_telegram"),
      },
      recentTransfers: recent,
      phones: this.listPhones(),
      jobs: this.listJobs(50),
    };
  }
}

module.exports = { Store };
