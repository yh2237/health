import type { MonitoredService } from "./config";

// Cloudflare Tunnel エラーページの特徴的な文字列（小文字で比較）
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
  // 日本語環境でのCloudflareエラーも念のため
  "オリジンに到達できません",
];

export interface CheckResult {
  serviceId: string;
  timestamp: number; // epoch ms
  ok: boolean;
  status: number | null; // HTTP status, null if network error/timeout
  latencyMs: number;
  error?: string; // エラー概要
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
      // Cloudflare Workerからのfetchはキャッシュをバイパス
      cf: { cacheTtl: 0, cacheEverything: false } as any,
      headers: {
        "User-Agent": "health-monitor/1.0 (+cf-worker)",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      redirect: "follow",
    });
    const latency = Date.now() - start;

    // ステータスが200-299以外は即ダウン判定
    if (!res.ok) {
      // ボディも読んでTunnelエラーか確認（502等のボディにTunnelエラーが含まれることがある）
      let body = "";
      try {
        body = await res.text();
      } catch {}
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

    // 200系でもボディがTunnelエラーページならダウン扱い
    // 全文読むと重いので先頭8KB程度だけ読む
    let bodySnippet = "";
    try {
      // text()だと全文読むが、TunnelエラーページはHTMLなので先頭で判定可能
      const text = await res.text();
      bodySnippet = text.slice(0, 8192);
    } catch {
      // ボディ読み取り失敗は無視（ステータスが200なら一旦OK扱い）
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
  // Cloudflare Tunnelがオリジンに到達できないときによく返すコード
  return status === 502 || status === 503 || status === 530 || status === 521 || status === 522 || status === 523;
}
