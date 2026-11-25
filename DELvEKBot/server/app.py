#!/usr/bin/env python3
"""DELvEKBot decrypt queue API — phone worker contract."""

from __future__ import annotations

import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("DELVEKBOT_DATA", "/var/lib/delvekbot"))
DB_PATH = DATA_DIR / "queue.db"
IPA_DIR = DATA_DIR / "ipas"
WORKER_TOKEN = os.environ.get("DECRYPT_WORKER_TOKEN", "")
ADMIN_TOKEN = os.environ.get("DELVEKBOT_ADMIN_TOKEN", WORKER_TOKEN)
LEASE_SECONDS = int(os.environ.get("DELVEKBOT_LEASE_SECONDS", "900"))
HOST = os.environ.get("DELVEKBOT_HOST", "127.0.0.1")
PORT = int(os.environ.get("DELVEKBOT_PORT", "8080"))

app = FastAPI(title="DELvEKBot", version="1.0.0")


def _now() -> int:
    return int(time.time())


@contextmanager
def db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IPA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              url TEXT NOT NULL,
              status TEXT NOT NULL,
              error TEXT,
              progress TEXT,
              name TEXT,
              ipa_path TEXT,
              lease_expires_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.commit()
        yield conn
        conn.commit()
    finally:
        conn.close()


def require_worker(x_decrypt_worker_token: str | None = Header(default=None)) -> None:
    if not WORKER_TOKEN:
        raise HTTPException(500, "server misconfigured: DECRYPT_WORKER_TOKEN unset")
    if not x_decrypt_worker_token or x_decrypt_worker_token != WORKER_TOKEN:
        raise HTTPException(401, "invalid worker token")


def require_admin(x_delvekbot_admin_token: str | None = Header(default=None)) -> None:
    token = x_delvekbot_admin_token or ""
    if not ADMIN_TOKEN or token != ADMIN_TOKEN:
        raise HTTPException(401, "invalid admin token")


class EnqueueBody(BaseModel):
    url: str = Field(min_length=8)


class ProgressBody(BaseModel):
    id: str
    msg: str = ""


class FailBody(BaseModel):
    id: str
    error: str = "failed"


def _reap_expired(conn: sqlite3.Connection) -> None:
    now = _now()
    conn.execute(
        """
        UPDATE jobs
        SET status = 'queued', lease_expires_at = NULL, updated_at = ?
        WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
        """,
        (now, now),
    )


@app.get("/health")
def health():
    return {"ok": True, "service": "delvekbot"}


@app.post("/api/decrypt/admin/enqueue")
def enqueue(body: EnqueueBody, _: None = Depends(require_admin)):
    job_id = str(uuid.uuid4())
    now = _now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO jobs (id, url, status, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?)
            """,
            (job_id, body.url.strip(), now, now),
        )
    return {"ok": True, "id": job_id, "url": body.url.strip()}


@app.get("/api/decrypt/admin/jobs")
def list_jobs(_: None = Depends(require_admin)):
    with db() as conn:
        _reap_expired(conn)
        rows = conn.execute(
            """
            SELECT id, url, status, error, progress, name, created_at, updated_at, lease_expires_at
            FROM jobs ORDER BY created_at DESC LIMIT 100
            """
        ).fetchall()
    return {"ok": True, "jobs": [dict(r) for r in rows]}


@app.post("/api/decrypt/worker/claim")
def claim(_: None = Depends(require_worker)):
    now = _now()
    with db() as conn:
        _reap_expired(conn)
        row = conn.execute(
            """
            SELECT id, url FROM jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            LIMIT 1
            """
        ).fetchone()
        if not row:
            return {"job": None}
        conn.execute(
            """
            UPDATE jobs
            SET status = 'leased', lease_expires_at = ?, updated_at = ?, progress = ?
            WHERE id = ? AND status = 'queued'
            """,
            (now + LEASE_SECONDS, now, "claimed", row["id"]),
        )
        # Confirm we still own it (race-safe enough for single worker).
        owned = conn.execute(
            "SELECT id, url FROM jobs WHERE id = ? AND status = 'leased'",
            (row["id"],),
        ).fetchone()
        if not owned:
            return {"job": None}
        return {"id": owned["id"], "url": owned["url"]}


@app.post("/api/decrypt/worker/progress")
def progress(body: ProgressBody, _: None = Depends(require_worker)):
    now = _now()
    with db() as conn:
        cur = conn.execute(
            """
            UPDATE jobs
            SET progress = ?, lease_expires_at = ?, updated_at = ?
            WHERE id = ? AND status = 'leased'
            """,
            (body.msg, now + LEASE_SECONDS, now, body.id),
        )
        if cur.rowcount == 0:
            return JSONResponse({"ok": False, "error": "job not leased"}, status_code=409)
    return {"ok": True}


@app.post("/api/decrypt/worker/fail")
def fail(body: FailBody, _: None = Depends(require_worker)):
    now = _now()
    with db() as conn:
        cur = conn.execute(
            """
            UPDATE jobs
            SET status = 'failed', error = ?, lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'leased'
            """,
            (body.error, now, body.id),
        )
        if cur.rowcount == 0:
            return JSONResponse({"ok": False, "error": "job not leased"}, status_code=409)
    return {"ok": True}


@app.post("/api/decrypt/worker/complete")
async def complete(
    request: Request,
    id: str = Query(...),
    name: str = Query(""),
    _: None = Depends(require_worker),
):
    now = _now()
    safe_name = "".join(c for c in (name or id) if c.isalnum() or c in ("-", "_", ".", " "))[:120] or id
    out = IPA_DIR / f"{id}_{safe_name}.ipa"
    data = await request.body()
    if not data:
        raise HTTPException(400, "empty body")
    out.write_bytes(data)
    with db() as conn:
        cur = conn.execute(
            """
            UPDATE jobs
            SET status = 'done', name = ?, ipa_path = ?, lease_expires_at = NULL,
                error = NULL, updated_at = ?, progress = 'complete'
            WHERE id = ? AND status IN ('leased', 'done')
            """,
            (name or safe_name, str(out), now, id),
        )
        if cur.rowcount == 0:
            out.unlink(missing_ok=True)
            return JSONResponse({"ok": False, "error": "job not leased"}, status_code=409)
    return {"ok": True, "success": True, "id": id, "name": name or safe_name}


def main() -> None:
    if not WORKER_TOKEN:
        raise SystemExit("Set DECRYPT_WORKER_TOKEN before starting the API")
    import uvicorn

    uvicorn.run("app:app", host=HOST, port=PORT, workers=1)


if __name__ == "__main__":
    main()
