"""Owner-scoped research queue and explicit notes, shared by the desktop and server workers."""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

DIMENSIONS = 1536
LEASE_SECONDS = 120
MAX_ATTEMPTS = 3


def installation_owner(directory: Path) -> str:
    """An OS-profile-local random identifier also partitions a shared PostgreSQL database."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "workflow-owner"
    if not path.exists():
        temporary = directory / f".workflow-owner-{uuid4()}"
        try:
            with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as handle:
                handle.write(str(uuid4()))
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            temporary.unlink(missing_ok=True)
    return str(UUID(path.read_text(encoding="ascii")))


def vector_json(vector):
    if (not isinstance(vector, list) or len(vector) != DIMENSIONS
            or not all(type(n) in (int, float) and math.isfinite(n) for n in vector)
            or not any(vector)):
        return None
    return json.dumps(vector, separators=(",", ":"))


class WorkflowStore:
    def __init__(self, path: Path, owner: str, dsn: str = ""):
        self.owner, self.path, self.dsn = owner, path, dsn
        if not dsn:
            path.parent.mkdir(parents=True, exist_ok=True)
            os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
        with self.transaction() as sql:
            if dsn:
                sql("CREATE EXTENSION IF NOT EXISTS vector")
            sql("CREATE TABLE IF NOT EXISTS cg_workspaces (owner TEXT PRIMARY KEY)")
            sql("INSERT INTO cg_workspaces(owner) VALUES(?) ON CONFLICT DO NOTHING", (owner,))
            sql("""CREATE TABLE IF NOT EXISTS cg_jobs (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, prompt TEXT NOT NULL,
                language TEXT NOT NULL, state TEXT NOT NULL, created DOUBLE PRECISION NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, expires DOUBLE PRECISION,
                result TEXT, UNIQUE(owner,request_id))""")
            sql("CREATE INDEX IF NOT EXISTS cg_jobs_queue ON cg_jobs(owner,state,created)")
            embedding = f"vector({DIMENSIONS})" if dsn else "TEXT"
            sql(f"""CREATE TABLE IF NOT EXISTS cg_notes (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL, created DOUBLE PRECISION NOT NULL,
                model TEXT, embedding {embedding}, UNIQUE(owner,body))""")
            sql("CREATE INDEX IF NOT EXISTS cg_notes_owner ON cg_notes(owner,created)")
            if dsn:
                sql("CREATE INDEX IF NOT EXISTS cg_notes_vector ON cg_notes USING hnsw(embedding vector_cosine_ops)")

    @contextmanager
    def transaction(self, *, write=True):
        if self.dsn:
            import psycopg
            from psycopg.rows import dict_row
            conn = psycopg.connect(self.dsn, connect_timeout=4, options="-c statement_timeout=8000", row_factory=dict_row)
        else:
            conn = sqlite3.connect(self.path, timeout=5)
            conn.row_factory = sqlite3.Row
        try:
            if not self.dsn and write:
                conn.execute("BEGIN IMMEDIATE")
            def execute(stmt, args=()):
                return conn.execute(stmt.replace("?", "%s") if self.dsn else stmt, args)
            yield execute
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def lock_owner(self, sql):
        if self.dsn:
            sql("SELECT owner FROM cg_workspaces WHERE owner=? FOR UPDATE", (self.owner,)).fetchone()

    def enqueue(self, request_id: str, prompt: str, language: str):
        with self.transaction() as sql:
            self.lock_owner(sql)
            args = (self.owner, request_id)
            existing = sql("SELECT id,prompt,language FROM cg_jobs WHERE owner=? AND request_id=?", args).fetchone()
            if existing:
                if existing["prompt"] != prompt or existing["language"] != language:
                    raise ValueError("conflict")
                return existing["id"]
            if sql("SELECT count(*) AS n FROM cg_jobs WHERE owner=?", (self.owner,)).fetchone()["n"] >= 50:
                raise ValueError("limit")
            job_id = str(uuid4())
            sql("INSERT INTO cg_jobs(id,owner,request_id,prompt,language,state,created) VALUES(?,?,?,?,?,'queued',?)",
                (job_id, *args, prompt, language, time.time()))
            return job_id

    def claim(self, now=None):
        now = time.time() if now is None else now
        with self.transaction() as sql:
            self.lock_owner(sql)
            sql("""UPDATE cg_jobs SET state='failed',lease=NULL,expires=NULL WHERE owner=? AND state='running'
                   AND attempts>=? AND expires<=?""", (self.owner, MAX_ATTEMPTS, now))
            row = sql("""SELECT id,prompt,language,attempts FROM cg_jobs WHERE owner=? AND state IN ('queued','running')
                         AND (expires IS NULL OR expires<=?) ORDER BY created,id LIMIT 1""",
                      (self.owner, now)).fetchone()
            if not row:
                return None
            lease = str(uuid4())
            sql("UPDATE cg_jobs SET state='running',attempts=attempts+1,lease=?,expires=? WHERE id=? AND owner=?",
                (lease, now + LEASE_SECONDS, row["id"], self.owner))
            return {**dict(row), "attempts": row["attempts"] + 1, "lease": lease}

    def retry(self, job, *, shutdown=False):
        with self.transaction() as sql:
            state = "queued" if shutdown or job["attempts"] < MAX_ATTEMPTS else "failed"
            delay = 0 if shutdown else 2 ** job["attempts"]
            sql("""UPDATE cg_jobs SET state=?,expires=?,lease=NULL,attempts=attempts-?
                   WHERE owner=? AND id=? AND state='running' AND lease=?""",
                (state, time.time() + delay, int(shutdown), self.owner, job["id"], job["lease"]))

    def finish(self, job, state, result=None):
        with self.transaction() as sql:
            return sql("""UPDATE cg_jobs SET state=?,result=?,lease=NULL,expires=NULL
                          WHERE owner=? AND id=? AND state='running' AND lease=?""",
                       (state, json.dumps(result, ensure_ascii=False) if result else None, self.owner,
                        job["id"], job["lease"])).rowcount == 1

    def owns_claim(self, job):
        with self.transaction(write=False) as sql:
            return bool(sql("SELECT 1 FROM cg_jobs WHERE owner=? AND id=? AND state='running' AND lease=?",
                            (self.owner, job["id"], job["lease"])).fetchone())

    def cancel(self, job_id):
        with self.transaction() as sql:
            return sql("""UPDATE cg_jobs SET state='cancelled',lease=NULL,expires=NULL WHERE owner=? AND id=?
                          AND state IN ('queued','running')""", (self.owner, job_id)).rowcount == 1

    def jobs(self):
        with self.transaction(write=False) as sql:
            rows = sql("SELECT id,prompt,language,state,result FROM cg_jobs WHERE owner=? ORDER BY created DESC,id",
                       (self.owner,)).fetchall()
            return [{**dict(r), "result": json.loads(r["result"]) if r["result"] else None} for r in rows]

    def delete_job(self, job_id):
        with self.transaction() as sql:
            return sql("DELETE FROM cg_jobs WHERE owner=? AND id=? AND state NOT IN ('queued','running')",
                       (self.owner, job_id)).rowcount == 1

    def note(self, body, vector, model):
        with self.transaction() as sql:
            self.lock_owner(sql)
            existing = sql("SELECT id FROM cg_notes WHERE owner=? AND body=?", (self.owner, body)).fetchone()
            if not existing and sql("SELECT count(*) AS n FROM cg_notes WHERE owner=?", (self.owner,)).fetchone()["n"] >= 100:
                raise ValueError("limit")
            note_id = existing["id"] if existing else str(uuid4())
            expr = "CAST(? AS vector)" if self.dsn else "?"
            sql(f"""INSERT INTO cg_notes(id,owner,body,created,model,embedding) VALUES(?,?,?,?,?,{expr})
                    ON CONFLICT(owner,body) DO UPDATE SET embedding=excluded.embedding, model=excluded.model""",
                (note_id, self.owner, body, time.time(), model, vector_json(vector)))
            return note_id

    def delete_note(self, note_id):
        with self.transaction() as sql:
            return sql("DELETE FROM cg_notes WHERE owner=? AND id=?", (self.owner, note_id)).rowcount == 1

    def notes(self):
        with self.transaction(write=False) as sql:
            return [dict(r) for r in sql("SELECT id,body FROM cg_notes WHERE owner=? ORDER BY created DESC,id",
                                          (self.owner,))]

    def has_notes(self):
        with self.transaction(write=False) as sql:
            return bool(sql("SELECT 1 FROM cg_notes WHERE owner=? LIMIT 1", (self.owner,)).fetchone())

    def search(self, query, vector, model):
        encoded = vector_json(vector)
        scores = {}
        with self.transaction(write=False) as sql:
            if self.dsn and encoded:
                matches = sql("""SELECT id,1-(embedding <=> CAST(? AS vector)) AS score FROM cg_notes
                                 WHERE owner=? AND model=? AND embedding IS NOT NULL
                                 ORDER BY embedding <=> CAST(? AS vector) LIMIT 6""",
                              (encoded, self.owner, model, encoded))
                scores = {r["id"]: r["score"] for r in matches}
            columns = "id,body" if self.dsn or not encoded else "id,body,embedding,model"
            notes = sql(f"SELECT {columns} FROM cg_notes WHERE owner=? ORDER BY created DESC,id", (self.owner,)).fetchall()
        query = query.casefold()
        terms = set(re.findall(r"\w+", query))
        ranked = []
        for note in notes:
            body = note["body"].casefold()
            lexical = len(terms.intersection(re.findall(r"\w+", body))) / max(1, len(terms))
            if query in body or body in query:
                lexical = 1
            semantic = scores.get(note["id"], 0)
            if not self.dsn and encoded and note["model"] == model and note["embedding"]:
                other = json.loads(note["embedding"])
                semantic = sum(a*b for a,b in zip(vector, other)) / (math.hypot(*vector) * math.hypot(*other))
            if lexical or semantic >= 0.32:
                ranked.append((max(lexical, semantic) + min(lexical, semantic)*0.1, dict(id=note["id"], body=note["body"])))
        return [n for _, n in sorted(ranked, key=lambda pair: pair[0], reverse=True)[:3]]
