import { Hono } from "hono";
import { SERVICES, RETENTION_DAYS } from "./config";
import { checkService, type CheckResult } from "./checker";

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
});

app.options("/api/*", (c) => c.text("", 200));

async function ensureTable(env: Env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        status INTEGER,
        latency_ms INTEGER NOT NULL,
        error TEXT,
        is_tunnel_error INTEGER NOT NULL DEFAULT 0
      )`
    ).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_checks_service_time ON checks(service_id, timestamp)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_checks_timestamp ON checks(timestamp)`).run();
  } catch {}
}

function rowToCheckResult(row: any): CheckResult {
  return {
    serviceId: row.service_id,
    timestamp: row.timestamp,
    ok: !!row.ok,
    status: row.status,
    latencyMs: row.latency_ms,
    error: row.error ?? undefined,
    isTunnelError: !!row.is_tunnel_error,
  };
}

async function insertCheck(env: Env, result: CheckResult) {
  await ensureTable(env);
  await env.DB.prepare(
    `INSERT INTO checks (service_id, timestamp, ok, status, latency_ms, error, is_tunnel_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      result.serviceId,
      result.timestamp,
      result.ok ? 1 : 0,
      result.status,
      result.latencyMs,
      result.error ?? null,
      result.isTunnelError ? 1 : 0
    )
    .run();
}

async function getChecks(env: Env, serviceId: string, sinceMs: number): Promise<CheckResult[]> {
  await ensureTable(env);
  const res = await env.DB.prepare(
    `SELECT service_id, timestamp, ok, status, latency_ms, error, is_tunnel_error
     FROM checks WHERE service_id = ? AND timestamp >= ? ORDER BY timestamp ASC`
  )
    .bind(serviceId, sinceMs)
    .all();
  return (res.results ?? []).map(rowToCheckResult);
}

async function getRecentChecks(env: Env, serviceId: string, limit: number): Promise<CheckResult[]> {
  await ensureTable(env);
  const res = await env.DB.prepare(
    `SELECT service_id, timestamp, ok, status, latency_ms, error, is_tunnel_error
     FROM checks WHERE service_id = ? ORDER BY timestamp DESC LIMIT ?`
  )
    .bind(serviceId, limit)
    .all();
  return (res.results ?? []).map(rowToCheckResult).reverse();
}

async function getLastCheck(env: Env, serviceId: string): Promise<CheckResult | null> {
  await ensureTable(env);
  const row = await env.DB.prepare(
    `SELECT service_id, timestamp, ok, status, latency_ms, error, is_tunnel_error
     FROM checks WHERE service_id = ? ORDER BY timestamp DESC LIMIT 1`
  )
    .bind(serviceId)
    .first();
  return row ? rowToCheckResult(row) : null;
}

async function getStats(env: Env, serviceId: string, sinceMs: number): Promise<{ total: number; up: number }> {
  await ensureTable(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as total, COALESCE(SUM(ok), 0) as up FROM checks WHERE service_id = ? AND timestamp >= ?`
  )
    .bind(serviceId, sinceMs)
    .first<any>();
  return { total: Number(row?.total ?? 0), up: Number(row?.up ?? 0) };
}

async function getTotalCount(env: Env, serviceId: string): Promise<number> {
  await ensureTable(env);
  const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM checks WHERE service_id = ?`)
    .bind(serviceId)
    .first<any>();
  return Number(row?.c ?? 0);
}

async function cleanupOld(env: Env) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    await env.DB.prepare(`DELETE FROM checks WHERE timestamp < ?`).bind(cutoff).run();
  } catch {}
}

export type Bucket = {
  start: number;
  end: number;
  total: number;
  up: number;
  down: number;
  uptime: number | null;
  avgLatency: number | null;
  status: "up" | "degraded" | "down" | "nodata";
};

function aggregateBuckets(checks: CheckResult[], bucketMinutes: number, days: number): Bucket[] {
  const now = Date.now();
  const bucketMs = bucketMinutes * 60 * 1000;
  const totalBuckets = Math.ceil((days * 24 * 60) / bucketMinutes);
  const endBucketStart = Math.floor(now / bucketMs) * bucketMs;
  const startTime = endBucketStart - (totalBuckets - 1) * bucketMs;

  const map = new Map<number, CheckResult[]>();
  for (let i = 0; i < totalBuckets; i++) {
    map.set(startTime + i * bucketMs, []);
  }
  for (const c of checks) {
    if (c.timestamp < startTime) continue;
    const bucketStart = Math.floor(c.timestamp / bucketMs) * bucketMs;
    const arr = map.get(bucketStart);
    if (arr) arr.push(c);
  }

  const result: Bucket[] = [];
  for (let i = 0; i < totalBuckets; i++) {
    const start = startTime + i * bucketMs;
    const end = start + bucketMs;
    const bucketChecks = map.get(start) ?? [];
    const total = bucketChecks.length;
    const up = bucketChecks.filter((c) => c.ok).length;
    const down = total - up;
    const uptime = total === 0 ? null : up / total;
    const avgLatency =
      total === 0 ? null : Math.round(bucketChecks.reduce((s, c) => s + c.latencyMs, 0) / total);
    let status: Bucket["status"] = "nodata";
    if (total === 0) status = "nodata";
    else if (uptime === 1) status = "up";
    else if (uptime !== null && uptime >= 0.5) status = "degraded";
    else status = "down";
    result.push({ start, end, total, up, down, uptime, avgLatency, status });
  }
  return result;
}

app.get("/api/services", (c) => {
  return c.json({
    services: SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      host: (() => {
        try {
          return new URL(s.url).host;
        } catch {
          return s.url;
        }
      })(),
    })),
  });
});

app.get("/api/status", async (c) => {
  const env = c.env;
  const now = Date.now();
  const cutoffs = {
    "24h": now - 1 * 24 * 60 * 60 * 1000,
    "7d": now - 7 * 24 * 60 * 60 * 1000,
    "30d": now - 30 * 24 * 60 * 60 * 1000,
    "90d": now - 90 * 24 * 60 * 60 * 1000,
  };

  const results = await Promise.all(
    SERVICES.map(async (s) => {
      const [last, total, s24, s7, s30, s90, recent7d] = await Promise.all([
        getLastCheck(env, s.id),
        getTotalCount(env, s.id),
        getStats(env, s.id, cutoffs["24h"]),
        getStats(env, s.id, cutoffs["7d"]),
        getStats(env, s.id, cutoffs["30d"]),
        getStats(env, s.id, cutoffs["90d"]),
        getChecks(env, s.id, cutoffs["7d"]),
      ]);

      const uptime = (st: { total: number; up: number }) =>
        st.total === 0 ? null : st.up / st.total;

      return {
        id: s.id,
        name: s.name,
        url: s.url,
        host: (() => {
          try {
            return new URL(s.url).host;
          } catch {
            return s.url;
          }
        })(),
        lastCheck: last,
        totalChecks: total,
        uptime: {
          "24h": uptime(s24),
          "7d": uptime(s7),
          "30d": uptime(s30),
          "90d": uptime(s90),
        },
        recentBuckets: aggregateBuckets(recent7d, 60, 7).slice(-24),
      };
    })
  );
  return c.json({ services: results, generatedAt: Date.now() });
});

app.get("/api/history", async (c) => {
  const serviceId = c.req.query("service") ?? c.req.query("serviceId");
  const bucketParam = c.req.query("bucket");
  const daysParam = c.req.query("days");

  if (!serviceId) return c.json({ error: "missing ?service=xxx" }, 400);
  const svc = SERVICES.find((s) => s.id === serviceId);
  if (!svc) return c.json({ error: "service not found" }, 404);

  const bucketMinutes = bucketParam === "30" ? 30 : 60;
  let days = parseInt(daysParam ?? "90", 10);
  if (![1, 3, 7, 14, 30, 90].includes(days)) days = 90;

  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const checks = await getChecks(c.env, serviceId, since);
  const buckets = aggregateBuckets(checks, bucketMinutes, days);
  const recentChecks = await getRecentChecks(c.env, serviceId, 100);
  const total = await getTotalCount(c.env, serviceId);

  return c.json({
    service: { id: svc.id, name: svc.name, url: svc.url },
    bucketMinutes,
    days,
    buckets,
    recentChecks: recentChecks.reverse(),
    totalChecks: total,
  });
});

app.post("/api/check", async (c) => {
  const serviceId = c.req.query("service");
  const targets = serviceId ? SERVICES.filter((s) => s.id === serviceId) : SERVICES;
  if (targets.length === 0) return c.json({ error: "service not found" }, 404);

  const results: CheckResult[] = [];
  for (const svc of targets) {
    const r = await checkService(svc);
    await insertCheck(c.env, r);
    results.push(r);
  }
  await cleanupOld(c.env);
  return c.json({ results });
});

app.get("/api/check", async (c) => {
  const serviceId = c.req.query("service");
  const targets = serviceId ? SERVICES.filter((s) => s.id === serviceId) : SERVICES;
  if (targets.length === 0) return c.json({ error: "service not found" }, 404);
  const results: CheckResult[] = [];
  for (const svc of targets) {
    const r = await checkService(svc);
    await insertCheck(c.env, r);
    results.push(r);
  }
  await cleanupOld(c.env);
  return c.json({ results });
});

app.get("/api/health", (c) => c.json({ ok: true, version: "1.0.0" }));

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  console.log(`[cron] tick at ${new Date().toISOString()}`);
  const results = await Promise.all(SERVICES.map((s) => checkService(s)));
  for (const r of results) {
    try {
      await insertCheck(env, r);
      console.log(`[check] ${r.serviceId}: ${r.ok ? "UP" : "DOWN"} ${r.status ?? "-"} ${r.latencyMs}ms ${r.error ?? ""}`);
    } catch (e) {
      console.error(`[check] failed to save ${r.serviceId}`, e);
    }
  }
  await cleanupOld(env);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    if (env.ASSETS) {
      try {
        return await env.ASSETS.fetch(request);
      } catch {}
    }
    return app.fetch(request, env, ctx);
  },
  scheduled: handleScheduled,
};
