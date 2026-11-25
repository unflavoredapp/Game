/**
 * In-process demo node so getipa.fast can complete jobs without a phone.
 * Disable with DEMO_NODE=0.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {{ baseUrl: string, nodeToken: string, nodeId?: string }} opts
 */
export function startDemoNode(opts) {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const nodeToken = opts.nodeToken;
  const nodeId = opts.nodeId || "demo-node-1";
  let stopped = false;

  async function api(pathname, init = {}) {
    const headers = {
      "X-Decrypt-Node-Token": nodeToken,
      ...(init.headers || {}),
    };
    const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function tick() {
    await api("/v0/node/hello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: nodeId,
        countries: ["us", "gb", "in", "ca", "au", "de", "fr", "jp"],
        capabilities: { backends: ["buddy3", "demo"], jailbreak: "demo" },
        freeBytes: 50_000_000_000,
        totalBytes: 128_000_000_000,
      }),
    });

    const claimed = await api("/v0/node/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: nodeId }),
    });

    if (!claimed?.job) return;

    const job = claimed.job;
    const stages = [
      { stage: "resolve", percent: 15, message: "resolving listing" },
      { stage: "install", percent: 40, message: "demo install" },
      { stage: "decrypt", percent: 75, message: "demo decrypt" },
      { stage: "upload", percent: 90, message: "packaging artifact" },
    ];
    for (const s of stages) {
      if (stopped) return;
      await api("/v0/node/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: nodeId, jobId: job.id, ...s }),
      });
      await sleep(400);
    }

    const name = `demo-${job.id.slice(0, 8)}.ipa`;
    const payload = Buffer.from(
      `getipa.fast demo artifact\njob=${job.id}\nurl=${job.url}\ncountry=${job.country}\n`
    );
    const q = new URLSearchParams({
      jobId: job.id,
      name,
      nodeId,
    });
    await api(`/v0/node/complete?${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
    });
  }

  async function loop() {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        // Relay may still be booting; keep trying.
        if (err.status !== 409) {
          console.warn(`[demo-node] ${err.message}`);
        }
      }
      await sleep(1200);
    }
  }

  loop();
  console.log(`[demo-node] running as ${nodeId} (set DEMO_NODE=0 to disable)`);
  return () => {
    stopped = true;
  };
}
