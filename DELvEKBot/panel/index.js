#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const css = require("./css");
const { Store } = require("./store");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DELVEKBOT_DATA || path.join(__dirname, "data");
const WORKER_TOKEN = process.env.DECRYPT_WORKER_TOKEN || "";
const ADMIN_TOKEN = process.env.DELVEKBOT_ADMIN_TOKEN || WORKER_TOKEN;
const LEASE_MS = Number(process.env.DELVEKBOT_LEASE_SECONDS || 900) * 1000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

if (!WORKER_TOKEN) {
  console.error("DECRYPT_WORKER_TOKEN is required");
  process.exit(1);
}

const store = new Store(DATA_DIR);
const app = express();

let telegram = null;
if (TELEGRAM_BOT_TOKEN) {
  telegram = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  console.log("Telegram bot configured");
} else {
  console.warn("TELEGRAM_BOT_TOKEN unset — completions will stay on VPS only");
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  if (req.path === "/api/decrypt/worker/complete") return next();
  return express.json({ limit: "2mb" })(req, res, next);
});

function workerAuth(req, res, next) {
  const token = req.get("X-Decrypt-Worker-Token");
  if (!token || token !== WORKER_TOKEN) {
    return res.status(401).json({ ok: false, error: "invalid worker token" });
  }
  return next();
}

function adminAuth(req, res, next) {
  const header = req.get("X-Delvekbot-Admin-Token");
  const query = req.query.token;
  const token = header || query;
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "invalid admin token" });
  }
  return next();
}

function phoneIdFromReq(req) {
  return (
    req.get("X-Delvekbot-Phone") ||
    req.get("X-AS-ADID") ||
    req.body?.phoneId ||
    "default-phone"
  );
}

function formatBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatMbps(n) {
  if (!n) return "—";
  return `${Number(n).toFixed(2)} Mbps`;
}

async function deliverToTelegram(job) {
  if (!telegram || !TELEGRAM_CHAT_ID || !job?.ipaPath) {
    return null;
  }
  const started = Date.now();
  const bytes = job.ipaBytes || fs.statSync(job.ipaPath).size;
  try {
    const caption = [
      `DELvEKBot · ${job.name || job.id}`,
      `Upload: ${formatMbps(job.upload?.mbps)} (${formatBytes(bytes)})`,
      job.url,
    ].join("\n");
    await telegram.sendDocument(
      TELEGRAM_CHAT_ID,
      fs.createReadStream(job.ipaPath),
      { caption },
      { filename: path.basename(job.ipaPath), contentType: "application/octet-stream" }
    );
    const durationMs = Date.now() - started;
    return store.recordTelegramTransfer(job.id, { bytes, durationMs, ok: true });
  } catch (err) {
    const durationMs = Date.now() - started;
    store.recordTelegramTransfer(job.id, {
      bytes,
      durationMs,
      ok: false,
      error: String(err.message || err),
    });
    console.error("Telegram delivery failed:", err.message || err);
    return null;
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "delvekbot-panel",
    telegram: Boolean(telegram && TELEGRAM_CHAT_ID),
  });
});

app.get("/panel.css", (_req, res) => {
  res.type("text/css").send(css);
});

app.get("/", adminAuth, (_req, res) => {
  res.type("html").send(renderDashboard());
});

app.get("/api/admin/stats", adminAuth, (_req, res) => {
  res.json({ ok: true, ...store.stats() });
});

function normalizeCountry(value, fallback = "us") {
  const c = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  return (c.slice(0, 2) || fallback).slice(0, 2);
}

function countryFromStoreUrl(url) {
  const m = String(url).match(/apps\.apple\.com\/([a-z]{2})\//i);
  return m ? m[1].toLowerCase() : null;
}

app.post("/api/decrypt/admin/enqueue", adminAuth, (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url.startsWith("http")) {
    return res.status(400).json({ ok: false, error: "url required" });
  }
  const country = normalizeCountry(
    req.body?.country || countryFromStoreUrl(url) || "us"
  );
  const job = store.enqueue(url, country);
  return res.json({ ok: true, id: job.id, url: job.url, country: job.country });
});

app.get("/api/decrypt/admin/jobs", adminAuth, (_req, res) => {
  res.json({ ok: true, jobs: store.listJobs(100) });
});

app.post("/api/decrypt/worker/claim", workerAuth, (req, res) => {
  const phone = phoneIdFromReq(req);
  let countries = req.body?.countries;
  if (!Array.isArray(countries) || !countries.length) {
    const single = req.body?.country || req.get("X-Delvekbot-Country") || "us";
    countries = [single];
  }
  countries = countries.map((c) => normalizeCountry(c, "us"));
  store.touchPhone(phone, { status: "online", countries, country: countries[0] });
  const job = store.claim(phone, LEASE_MS, countries);
  if (!job) return res.json({ job: null });
  return res.json({ id: job.id, url: job.url, country: job.country });
});

app.post("/api/decrypt/worker/progress", workerAuth, (req, res) => {
  const id = req.body?.id;
  const msg = req.body?.msg || "";
  const percent = req.body?.percent;
  const stage = req.body?.stage || null;
  const job = store.progress(id, msg, LEASE_MS, percent, stage);
  if (!job) return res.status(409).json({ ok: false, error: "job not leased" });
  return res.json({ ok: true, percent: job.percent, stage: job.stage });
});

app.post("/api/decrypt/worker/fail", workerAuth, (req, res) => {
  const id = req.body?.id;
  const error = req.body?.error || "failed";
  const job = store.fail(id, error);
  if (!job) return res.status(409).json({ ok: false, error: "job not leased" });
  if (telegram && TELEGRAM_CHAT_ID) {
    telegram
      .sendMessage(TELEGRAM_CHAT_ID, `DELvEKBot failed · ${id}\n${error}`)
      .catch(() => {});
  }
  return res.json({ ok: true });
});

app.post(
  "/api/decrypt/worker/complete",
  workerAuth,
  (req, res, next) => {
    req._uploadStartedAt = Date.now();
    express.raw({ type: "*/*", limit: "2gb" })(req, res, (err) => {
      req._uploadEndedAt = Date.now();
      next(err);
    });
  },
  async (req, res) => {
  const id = String(req.query.id || "");
  const name = String(req.query.name || "");
  const phone = phoneIdFromReq(req);
  const startedAt = req._uploadStartedAt || Date.now();
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);

  if (!id || !buffer.length) {
    return res.status(400).json({ ok: false, error: "id and body required" });
  }

  const job = store.complete(id, { name, buffer, phoneId: phone, startedAt });
  if (!job) return res.status(409).json({ ok: false, error: "job not leased" });

  // Respond to phone first, then push to Telegram in background.
  res.json({
    ok: true,
    success: true,
    id: job.id,
    name: job.name,
    uploadMbps: job.upload?.mbps,
  });

  deliverToTelegram(job).catch((err) => {
    console.error("telegram background error:", err.message || err);
  });
});


function renderDashboard() {
  const token = ADMIN_TOKEN;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DELvEKBot</title>
  <link rel="stylesheet" href="/panel.css" />
</head>
<body>
  <div class="shell">
    <h1 class="brand">DELvEKBot</h1>
    <p class="tagline">Phone → VPS → Telegram. Queue jobs, watch workers, and track transfer speeds.</p>

    <div class="grid" id="stats">
      <div class="panel span-4"><div class="stat" id="s-queued">—</div><small>queued</small></div>
      <div class="panel span-4"><div class="stat" id="s-leased">—</div><small>in progress</small></div>
      <div class="panel span-4"><div class="stat" id="s-done">—</div><small>done</small></div>
      <div class="panel span-6"><div class="stat speed" id="s-up">—</div><small>avg phone → VPS</small></div>
      <div class="panel span-6"><div class="stat speed" id="s-tg">—</div><small>avg VPS → Telegram</small></div>
    </div>

    <div class="grid" style="margin-top:16px">
      <div class="panel span-12">
        <h2>Enqueue App Store URL</h2>
        <label for="url">URL</label>
        <input id="url" placeholder="https://apps.apple.com/in/app/.../id123456789" />
        <label for="country">Storefront country</label>
        <input id="country" maxlength="2" placeholder="us" value="us" style="max-width:6rem" />
        <p class="muted" style="margin:0 0 12px;font-size:0.75rem">Must match the phone’s Apple ID storefront (e.g. <code>in</code> for India).</p>
        <div class="row">
          <button id="enqueue" type="button">Queue job</button>
        </div>
        <div id="enqueue-msg"></div>
      </div>
      <div class="panel span-12">
        <h2>Phones</h2>
        <div id="phones" class="muted">Loading…</div>
      </div>
      <div class="panel span-12">
        <h2>Jobs</h2>
        <div id="jobs"></div>
      </div>
      <div class="panel span-12">
        <h2>Recent transfers</h2>
        <div id="transfers"></div>
      </div>
    </div>

    <footer>delvek.bot · refresh every 2s · admin token required</footer>
  </div>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const headers = {
      "Content-Type": "application/json",
      "X-Delvekbot-Admin-Token": TOKEN,
    };

    function bytes(n) {
      if (!n) return "0 B";
      const u = ["B","KB","MB","GB"];
      let i = 0, v = n;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return v.toFixed(i ? 1 : 0) + " " + u[i];
    }
    function mbps(n) { return n ? Number(n).toFixed(2) + " Mbps" : "—"; }
    function ago(ts) {
      if (!ts) return "—";
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return s + "s ago";
      if (s < 3600) return Math.floor(s/60) + "m ago";
      return Math.floor(s/3600) + "h ago";
    }

    async function refresh() {
      const res = await fetch("/api/admin/stats?token=" + encodeURIComponent(TOKEN), { headers });
      if (!res.ok) throw new Error("stats " + res.status);
      const data = await res.json();
      document.getElementById("s-queued").innerHTML = data.counts.queued + "<small>queued</small>";
      document.getElementById("s-leased").innerHTML = data.counts.leased + "<small>in progress</small>";
      document.getElementById("s-done").innerHTML = data.counts.done + "<small>done</small>";
      document.getElementById("s-up").innerHTML = mbps(data.avgMbps.phoneToVps) + "<small>avg phone → VPS</small>";
      document.getElementById("s-tg").innerHTML = mbps(data.avgMbps.vpsToTelegram) + "<small>avg VPS → Telegram</small>";

      const phones = data.phones || [];
      document.getElementById("phones").innerHTML = phones.length
        ? "<div class='phone-list'>" + phones.map(p => {
            const online = p.lastSeenAt && (Date.now() - p.lastSeenAt) < 120000;
            const countries = (p.countries && p.countries.length)
              ? p.countries
              : (p.country ? [p.country] : []);
            const active = p.activeJob;
            const pct = active
              ? Math.max(0, Math.min(100, Number(active.percent) || 0))
              : (typeof p.successRate === "number" ? p.successRate : null);
            const pctLabel = active ? (pct + "%") : (pct != null ? (pct + "%") : "—");
            const stage = active ? (active.stage || "working") : (online ? "idle" : "offline");
            return "<article class='phone-card'>" +
              "<div class='phone-card-top'>" +
                "<div style='min-width:0;flex:1'>" +
                  "<div class='job-title'>" + (p.id || "phone") + "</div>" +
                  "<div class='job-meta'>" +
                    "<span class='pill " + (online ? "online" : "offline") + "'>" + (online ? "online" : "offline") + "</span>" +
                    (active ? "<span class='pill leased'>busy</span>" : "") +
                    countries.map(c => "<span class='pill'>" + String(c).toUpperCase() + "</span>").join("") +
                    "<span>" + ago(p.lastSeenAt) + "</span>" +
                  "</div>" +
                "</div>" +
                "<div class='job-progress-pct' title='" + (active ? "active job" : "success rate") + "'>" + pctLabel + "</div>" +
              "</div>" +
              "<div class='phone-stats'>" +
                "<div class='phone-stat'><span class='n'>" + (p.jobsDone || 0) + "</span><span class='l'>done</span></div>" +
                "<div class='phone-stat'><span class='n'>" + (p.jobsFailed || 0) + "</span><span class='l'>failed</span></div>" +
                "<div class='phone-stat'><span class='n'>" + bytes(p.bytesIn || 0) + "</span><span class='l'>uploaded</span></div>" +
              "</div>" +
              (active
                ? ("<div class='phone-active'>" +
                    "<div class='job-progress-head'>" +
                      "<span class='job-stage'>" + stage + " · " + (active.name || active.id || "job") + "</span>" +
                      "<span class='muted mono'>" + pct + " / 100</span>" +
                    "</div>" +
                    "<div class='job-progress-track' role='progressbar' aria-valuenow='" + pct + "' aria-valuemin='0' aria-valuemax='100'>" +
                      "<div class='job-progress-fill' style='width:" + pct + "%'></div>" +
                    "</div>" +
                    (active.progress ? "<div class='job-msg'>" + active.progress + "</div>" : "") +
                  "</div>")
                : ("<div class='phone-idle'>" + (online ? "Waiting for next job · success " + (pct != null ? pct + "%" : "—") : "No recent heartbeat") + "</div>")
              ) +
            "</article>";
          }).join("") + "</div>"
        : "<span class='muted'>No phones have claimed yet.</span>";

      const jobs = data.jobs || [];
      function jobPercent(j) {
        if (j.status === "done") return 100;
        if (j.status === "queued") return Number(j.percent) || 0;
        if (typeof j.percent === "number") return Math.max(0, Math.min(100, j.percent));
        return 0;
      }
      function stageLabel(j) {
        if (j.status === "done") return "complete";
        if (j.status === "failed") return "failed";
        if (j.status === "queued") return "queued";
        return j.stage || "working";
      }
      document.getElementById("jobs").innerHTML = jobs.length
        ? "<div class='job-list'>" + jobs.map(j => {
            const pct = jobPercent(j);
            const stage = stageLabel(j);
            const fillClass = j.status === "done" ? "done" : (j.status === "failed" ? "failed" : (j.status === "queued" ? "queued" : ""));
            const title = j.name || (j.url ? String(j.url).split("/").filter(Boolean).slice(-2).join("/") : "Job");
            return "<article class='job-card'>" +
              "<div class='job-card-top'>" +
                "<div style='min-width:0;flex:1'>" +
                  "<div class='job-title'>" + title + "</div>" +
                  "<div class='job-url'>" + (j.url || "") + "</div>" +
                  "<div class='job-meta'>" +
                    "<span class='pill " + j.status + "'>" + j.status + "</span>" +
                    "<span>" + (j.country || "—").toUpperCase() + "</span>" +
                    "<span>" + (j.phoneId || "—") + "</span>" +
                    "<span>" + ago(j.updatedAt) + "</span>" +
                  "</div>" +
                "</div>" +
                "<div class='job-progress-pct'>" + pct + "%</div>" +
              "</div>" +
              "<div class='job-progress'>" +
                "<div class='job-progress-head'>" +
                  "<span class='job-stage'>" + stage + "</span>" +
                  "<span class='muted mono'>" + pct + " / 100</span>" +
                "</div>" +
                "<div class='job-progress-track' role='progressbar' aria-valuenow='" + pct + "' aria-valuemin='0' aria-valuemax='100'>" +
                  "<div class='job-progress-fill " + fillClass + "' style='width:" + pct + "%'></div>" +
                "</div>" +
              "</div>" +
              (j.progress ? "<div class='job-msg'>" + j.progress + "</div>" : "") +
              (j.error ? "<div class='err'>" + j.error + "</div>" : "") +
              "<div class='job-speeds mono'>↑ phone " + mbps(j.upload && j.upload.mbps) +
                " · ✈ telegram " + mbps(j.telegram && j.telegram.mbps) +
                (j.ipaBytes ? " · " + bytes(j.ipaBytes) : "") +
              "</div>" +
            "</article>";
          }).join("") + "</div>"
        : "<span class='muted'>No jobs yet.</span>";

      const transfers = data.recentTransfers || [];
      document.getElementById("transfers").innerHTML = "<table><thead><tr><th>Path</th><th>Name</th><th>Size</th><th>Speed</th><th>When</th></tr></thead><tbody>" +
        transfers.map(t => "<tr>" +
          "<td>" + (t.kind === "phone_to_vps" ? "Phone → VPS" : "VPS → Telegram") + (t.ok === false ? " <span class='err'>fail</span>" : "") + "</td>" +
          "<td>" + (t.name || t.jobId || "—") + "</td>" +
          "<td class='mono'>" + bytes(t.bytes) + "</td>" +
          "<td class='speed mono'>" + mbps(t.mbps) + "</td>" +
          "<td>" + ago(t.at) + "</td>" +
        "</tr>").join("") + "</tbody></table>";
    }

    document.getElementById("enqueue").onclick = async () => {
      const url = document.getElementById("url").value.trim();
      let country = (document.getElementById("country").value || "us").trim().toLowerCase();
      const fromUrl = (url.match(/apps\\.apple\\.com\\/([a-z]{2})\\//i) || [])[1];
      if (fromUrl) country = fromUrl.toLowerCase();
      const msg = document.getElementById("enqueue-msg");
      msg.className = "";
      msg.textContent = "Queuing…";
      try {
        const res = await fetch("/api/decrypt/admin/enqueue", {
          method: "POST",
          headers,
          body: JSON.stringify({ url, country }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || res.status);
        msg.className = "ok";
        msg.textContent = "Queued " + data.id + " · " + (data.country || country);
        document.getElementById("url").value = "";
        document.getElementById("country").value = data.country || country;
        refresh();
      } catch (e) {
        msg.className = "err";
        msg.textContent = String(e.message || e);
      }
    };

    refresh().catch(err => {
      document.getElementById("phones").innerHTML = "<span class='err'>" + err + "</span>";
    });
    setInterval(() => refresh().catch(() => {}), 2000);
  </script>
</body>
</html>`;
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "internal error" });
});

app.listen(PORT, HOST, () => {
  console.log(`DELvEKBot panel on http://${HOST}:${PORT}`);
  console.log(`Dashboard: http://${HOST}:${PORT}/?token=***`);
});
