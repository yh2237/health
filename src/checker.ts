import type { MonitoredService } from "./config";

const TUNNEL_ERROR_KEYWORDS = [
  "cloudflare tunnel",
  "unable to reach the origin",
  "bad gateway",
  "error 1033",
  "argo tunnel",
  "tunnel error",
  "origin is unreachable",
  "cloudflared",
  "error 502",
  "error 530",
  "ray id:",
  "オリジンに到達できません",
];

export interface CheckResult {
  serviceId: string;
  timestamp: number;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: string;
  isTunnelError?: boolean;
}

export async function checkService(service: MonitoredService): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), service.timeoutMs ?? 10000);

  try {
    const res = await fetch(service.url, {
      method: "GET",
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false } as any,
      headers: {
        "User-Agent": "health-monitor/1.0 (+cf-worker)",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      redirect: "follow",
    });
    const latency = Date.now() - start;

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch { }
      const isTunnel = isTunnelErrorBody(body);
      return {
        serviceId: service.id,
        timestamp: Date.now(),
        ok: false,
        status: res.status,
        latencyMs: latency,
        error: `HTTP ${res.status}${isTunnel ? " (Tunnel error)" : ""}`,
        isTunnelError: isTunnel || isTunnelStatus(res.status),
      };
    }

    let bodySnippet = "";
    try {
      const text = await res.text();
      bodySnippet = text.slice(0, 8192);
    } catch {
      return {
        serviceId: service.id,
        timestamp: Date.now(),
        ok: true,
        status: res.status,
        latencyMs: latency,
      };
    }

    if (isTunnelErrorBody(bodySnippet)) {
      return {
        serviceId: service.id,
        timestamp: Date.now(),
        ok: false,
        status: res.status,
        latencyMs: latency,
        error: "Tunnel error page (200 but body contains tunnel error)",
        isTunnelError: true,
      };
    }

    return {
      serviceId: service.id,
      timestamp: Date.now(),
      ok: true,
      status: res.status,
      latencyMs: latency,
    };
  } catch (e: any) {
    const latency = Date.now() - start;
    const msg = e?.name === "AbortError" ? "Timeout" : e?.message ?? String(e);
    return {
      serviceId: service.id,
      timestamp: Date.now(),
      ok: false,
      status: null,
      latencyMs: latency,
      error: msg,
      isTunnelError: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isTunnelErrorBody(body: string): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  return TUNNEL_ERROR_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function isTunnelStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 530 || status === 521 || status === 522 || status === 523;
}
