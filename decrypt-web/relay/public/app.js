const TOKEN_KEY = "getipa.operatorToken";

const tokenInput = document.getElementById("operator-token");
const form = document.getElementById("job-form");
const statusEl = document.getElementById("form-status");
const jobsEl = document.getElementById("jobs");
const refreshBtn = document.getElementById("refresh-jobs");

tokenInput.value = sessionStorage.getItem(TOKEN_KEY) || "";

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function token() {
  return tokenInput.value.trim();
}

async function api(pathname, init = {}) {
  const t = token();
  if (!t) throw new Error("Operator token required");
  const headers = {
    "X-Decrypt-Operator-Token": t,
    ...(init.headers || {}),
  };
  const res = await fetch(pathname, { ...init, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function renderJobs(jobs) {
  if (!jobs?.length) {
    jobsEl.innerHTML = `<p class="job-meta">No jobs yet. Queue an App Store URL above.</p>`;
    return;
  }
  jobsEl.innerHTML = jobs
    .map((job) => {
      const progress =
        job.progress?.message ||
        (job.status === "done" ? "ready" : job.error || job.status);
      const pct = job.progress?.percent != null ? `${job.progress.percent}% · ` : "";
      const download =
        job.status === "done"
          ? `<div class="job-actions"><a href="/v0/artifacts/${encodeURIComponent(job.id)}" data-download="${job.id}">Download IPA</a></div>`
          : "";
      return `<article class="job">
        <div class="job-main">
          <p class="job-url" title="${job.url}">${shortUrl(job.url)}</p>
          <p class="job-meta">${job.country?.toUpperCase() || "US"} · ${pct}${progress}</p>
        </div>
        <span class="pill ${job.status}">${job.status}</span>
        ${download}
      </article>`;
    })
    .join("");

  jobsEl.querySelectorAll("[data-download]").forEach((a) => {
    a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        const res = await api(a.getAttribute("href"));
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const tmp = document.createElement("a");
        tmp.href = url;
        tmp.download = `getipa-${a.dataset.download}.ipa`;
        tmp.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  });
}

async function refreshJobs() {
  if (!token()) {
    jobsEl.innerHTML = `<p class="job-meta">Enter your operator token to load jobs.</p>`;
    return;
  }
  try {
    const data = await api("/v0/jobs?limit=30");
    renderJobs(data.jobs || []);
  } catch (err) {
    setStatus(err.message, true);
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  sessionStorage.setItem(TOKEN_KEY, token());
  setStatus("Queueing…");
  try {
    const job = await api("/v0/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: document.getElementById("app-url").value.trim(),
        country: document.getElementById("country").value.trim().toLowerCase(),
        constraints: { backends: ["demo", "buddy3"] },
      }),
    });
    setStatus(`Queued ${job.id.slice(0, 8)}… demo node will pick it up`);
    document.getElementById("app-url").value = "";
    await refreshJobs();
  } catch (err) {
    setStatus(err.message, true);
  }
});

tokenInput.addEventListener("change", () => {
  sessionStorage.setItem(TOKEN_KEY, token());
  refreshJobs();
});

refreshBtn.addEventListener("click", () => refreshJobs());

refreshJobs();
setInterval(() => {
  if (token()) refreshJobs();
}, 2500);
