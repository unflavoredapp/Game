import express from "express";
import { Store } from "./store.js";

function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  if (x.length !== y.length) return false;
  let ok = 0;
  for (let i = 0; i < x.length; i++) ok |= x[i] ^ y[i];
  return ok === 0;
}

/**
 * @param {{ store: Store, operatorToken: string, nodeToken: string }} opts
 */
export function createApp(opts) {
  const { store, operatorToken, nodeToken } = opts;
  const app = express();

  app.get("/v0/health", (_req, res) => {
    res.json(store.health());
  });

  function requireOperator(req, res, next) {
    const token = req.get("X-Decrypt-Operator-Token");
    if (!timingSafeEqualStr(token, operatorToken)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  }

  function requireNode(req, res, next) {
    const token = req.get("X-Decrypt-Node-Token");
    if (!timingSafeEqualStr(token, nodeToken)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  }

  function handleErr(res, err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || "error" });
  }

  app.post("/v0/jobs", requireOperator, express.json(), (req, res) => {
    try {
      const url = req.body?.url;
      if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "url required" });
      }
      const job = store.enqueue(url, req.body.country, req.body.constraints);
      res.status(201).json(job);
    } catch (err) {
      handleErr(res, err);
    }
  });

  app.get("/v0/jobs", requireOperator, (req, res) => {
    const limit = Number(req.query.limit) || 50;
    res.json({ jobs: store.listJobs(limit) });
  });

  app.get("/v0/jobs/:id", requireOperator, (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    res.json(job);
  });

  app.get("/v0/nodes", requireOperator, (_req, res) => {
    res.json({ nodes: store.listNodes() });
  });

  app.get("/v0/artifacts/:jobId", requireOperator, (req, res) => {
    const found = store.artifactPath(req.params.jobId);
    if (!found) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", found.job.artifact.contentType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${found.job.artifact.name.replace(/"/g, "")}"`
    );
    if (found.job.artifact.sha256) {
      res.setHeader("X-Decrypt-Sha256", found.job.artifact.sha256);
    }
    res.sendFile(found.path);
  });

  app.post("/v0/node/hello", requireNode, express.json(), (req, res) => {
    try {
      res.json(store.hello(req.body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  app.post("/v0/node/claim", requireNode, express.json(), (req, res) => {
    try {
      res.json(store.claim(req.body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  app.post("/v0/node/progress", requireNode, express.json(), (req, res) => {
    try {
      res.json(store.progress(req.body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  app.post("/v0/node/fail", requireNode, express.json(), (req, res) => {
    try {
      res.json(store.fail(req.body));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Raw body = artifact bytes. Node identity via query/header (body is binary).
  app.post(
    "/v0/node/complete",
    requireNode,
    express.raw({ type: "*/*", limit: "2gb" }),
    (req, res) => {
      try {
        const jobId = String(req.query.jobId || "");
        const name = String(req.query.name || "artifact.bin");
        const nodeId = String(req.query.nodeId || req.get("X-Decrypt-Node-Id") || "");
        if (!nodeId || !jobId) {
          return res.status(400).json({ error: "nodeId and jobId required" });
        }
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
        const result = store.complete({
          id: nodeId,
          jobId,
          name: decodeURIComponent(name),
          buffer,
          contentType: req.get("Content-Type") || "application/octet-stream",
          sha256: req.get("X-Decrypt-Sha256") || undefined,
        });
        res.json(result);
      } catch (err) {
        handleErr(res, err);
      }
    }
  );

  return app;
}
