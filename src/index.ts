import { Hono } from "hono";
import { SERVICES, RETENTION_DAYS } from "./config";
import { checkService, type CheckResult } from "./checker";

type Env = {
  HEALTH_KV: KVNamespace;
  ASSETS: Fetcher;
};

type StoredHistory = {
  checks: CheckResult[];
  updatedAt: number;
};

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
});

app.options("/api/*", (c) => c.text("", 200));

// --- KV helpers ---
const kvKey = (serviceId: string) => `history:${serviceId}`;

async function loadHistory(env: Env, serviceId: string): Promise<StoredHistory> {
  if (!env.HEALTH_KV) return { checks: [], updatedAt: 0 };
  try {
    const raw = await env.HEALTH_KV.get(kvKey(serviceId), "json");
    if (raw && typeof raw === "object" && "checks" in (raw as any)) {
      return raw as StoredHistory;
    }
    return { checks: [], updatedAt: 0 };
  } catch {
    return { checks: [], updatedAt: 0 };
  }
}

async function saveHistory(env: Env, serviceId: string, history: StoredHistory) {
  if (!env.HEALTH_KV) return;
  // Trim by retention
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  history.checks = history.checks.filter((c) => c.timestamp >= cutoff);
  // Keep max 10000 entries to stay under KV limits (90d * 288 checks/day at 5min = ~25920, so we keep 10000 ~ 35d at 5min)
  // For 90d we need ~25920, KV value is 25MB so fine, but keep 26000 max
  if (history.checks.length > 26000) {
    history.checks = history.checks.slice(-26000);
  }
  history.updatedAt = Date.now();
  await env.HEALTH_KV.put(kvKey(serviceId), JSON.stringify(history));
}

async function appendCheck(env: Env, result: CheckResult) {
  const hist = await loadHistory(env, result.serviceId);
  hist.checks.push(result);
  await saveHistory(env, result.serviceId, hist);
}

// --- Bucket aggregation ---
export type Bucket = {
  start: number; // epoch ms
  end: number;
  total: number;
  up: number;
  down: number;
  uptime: number | null; // 0-1, null if no data
  avgLatency: number | null;
  status: "up" | "degraded" | "down" | "nodata";
};

function aggregateBuckets(checks: CheckResult[], bucketMinutes: number, days: number): Bucket[] {
  const now = Date.now();
  const bucketMs = bucketMinutes * 60 * 1000;
  const totalBuckets = Math.ceil((days * 24 * 60) / bucketMinutes);
  // Align to bucket boundary
  const endBucketStart = Math.floor(now / bucketMs) * bucketMs;
  const startTime = endBucketStart - (totalBuckets - 1) * bucketMs;

  // Map bucket start -> checks
  const map = new Map<number, CheckResult[]>();
  for (let i = 0; i < totalBuckets; i++) {
    map.set(startTime + i * bucketMs, []);
  }
  for (const c of checks) {
    if (c.timestamp < startTime) continue;
    // find bucket
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

function calcUptime(checks: CheckResult[], days: number): number | null {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const filtered = checks.filter((c) => c.timestamp >= cutoff);
  if (filtered.length === 0) return null;
  return filtered.filter((c) => c.ok).length / filtered.length;
}

// --- API routes ---

// GET /api/services
app.get("/api/services", (c) => {
  return c.json({
    services: SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      // URLのホスト部分のみ返す（セキュリティ配慮でフルURLは隠すオプションもあるが一旦そのまま）
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

// GET /api/status
app.get("/api/status", async (c) => {
  const env = c.env;
  const results = await Promise.all(
    SERVICES.map(async (s) => {
      const hist = await loadHistory(env, s.id);
      const last = hist.checks.length > 0 ? hist.checks[hist.checks.length - 1] : null;
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
        totalChecks: hist.checks.length,
        uptime: {
          "24h": calcUptime(hist.checks, 1),
          "7d": calcUptime(hist.checks, 7),
          "30d": calcUptime(hist.checks, 30),
          "90d": calcUptime(hist.checks, 90),
        },
        // 直近24hのバケット（1時間粒度）を付属してフロントで即描画できるように
        recentBuckets: aggregateBuckets(hist.checks, 60, 7).slice(-24),
      };
    })
  );
  return c.json({ services: results, generatedAt: Date.now() });
});

// GET /api/history?service=xxx&bucket=30|60&days=7|30|90
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
  // 30分粒度で90日は 4320バケット、60分で2160

  const hist = await loadHistory(c.env, serviceId);
  const buckets = aggregateBuckets(hist.checks, bucketMinutes, days);

  // 生チェックデータも最新100件だけ返す（デバッグ用）
  const recentChecks = hist.checks.slice(-100).reverse();

  return c.json({
    service: { id: svc.id, name: svc.name, url: svc.url },
    bucketMinutes,
    days,
    buckets,
    recentChecks,
    totalChecks: hist.checks.length,
  });
});

// POST /api/check - 手動でチェックをトリガー（デバッグ/開発用）
// ?service=xxx で特定サービスのみ、無指定で全サービス
app.post("/api/check", async (c) => {
  const serviceId = c.req.query("service");
  const targets = serviceId ? SERVICES.filter((s) => s.id === serviceId) : SERVICES;
  if (targets.length === 0) return c.json({ error: "service not found" }, 404);

  const results: CheckResult[] = [];
  for (const svc of targets) {
    const r = await checkService(svc);
    await appendCheck(c.env, r);
    results.push(r);
  }
  return c.json({ results });
});

// GET /api/check でも手動実行できるように（cronの手動発火用、ブラウザから叩きやすい）
app.get("/api/check", async (c) => {
  const serviceId = c.req.query("service");
  const targets = serviceId ? SERVICES.filter((s) => s.id === serviceId) : SERVICES;
  if (targets.length === 0) return c.json({ error: "service not found" }, 404);
  const results: CheckResult[] = [];
  for (const svc of targets) {
    const r = await checkService(svc);
    await appendCheck(c.env, r);
    results.push(r);
  }
  return c.json({ results });
});

// Health endpoint for worker itself
app.get("/api/health", (c) => c.json({ ok: true, version: "1.0.0" }));

// 404 for unknown API routes
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// --- Scheduled handler (cron) ---
async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  console.log(`[cron] tick at ${new Date().toISOString()}`);
  // 並列でチェック（同時実行数を制限しないとタイムアウトする可能性もあるが、サービス数は少ない想定なので並列でOK）
  const results = await Promise.all(SERVICES.map((s) => checkService(s)));
  // KVへの書き込みは直列で（同時書き込み競合を避けるためサービスごとに直列）
  for (const r of results) {
    try {
      await appendCheck(env, r);
      console.log(`[check] ${r.serviceId}: ${r.ok ? "UP" : "DOWN"} ${r.status ?? "-"} ${r.latencyMs}ms ${r.error ?? ""}`);
    } catch (e) {
      console.error(`[check] failed to save ${r.serviceId}`, e);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // APIはHonoで処理
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    // それ以外はAssets（フロント）を配信
    // wrangler.jsonc で assets.binding = "ASSETS" を指定している場合
    if (env.ASSETS) {
      try {
        return await env.ASSETS.fetch(request);
      } catch (e) {
        // ASSETSで見つからない場合はHonoにフォールバック（SPA対応でindex.htmlを返す想定）
        // Cloudflareの not_found_handling: single-page-application が自動でindex.htmlを返すが、
        // binding経由の場合は自前でフォールバックが必要なことがある
      }
    }
    // ASSETS bindingが無い環境（ローカル等）ではHonoの404を返すか、直接index.htmlを試す
    return app.fetch(request, env, ctx);
  },
  scheduled: handleScheduled,
};
