const servicesEl = document.getElementById("services");
const loadingEl = document.getElementById("loading");
const tooltipEl = document.getElementById("tooltip");
const lastUpdatedEl = document.getElementById("lastUpdated");
const refreshBtn = document.getElementById("refreshBtn");

let bucketMinutes = 60;
let days = 90;

document.querySelectorAll("#bucketToggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#bucketToggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    bucketMinutes = parseInt(btn.dataset.bucket, 10);
    load();
  });
});
document.querySelectorAll("#daysToggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#daysToggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    days = parseInt(btn.dataset.days, 10);
    load();
  });
});
refreshBtn.addEventListener("click", load);

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

function formatUptime(v) {
  if (v == null) return "-";
  return (v * 100).toFixed(2) + "%";
}
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatLatency(v) {
  if (v == null) return "-";
  return v + "ms";
}

function bucketColor(bucket) {
  if (bucket.status === "nodata") return "nodata";
  if (bucket.status === "up") return "up";
  if (bucket.status === "down") return "down";
  return "degraded";
}

function uptimeToColor(uptime) {
  // degradedの濃淡を uptime に応じて変える（任意）
  if (uptime == null) return "";
  if (uptime >= 1) return "";
  if (uptime >= 0.9) return ""; // yellow
  return "";
}

async function load() {
  loadingEl.hidden = false;
  servicesEl.innerHTML = "";
  try {
    const statusData = await fetchJson("/api/status");
    const services = statusData.services ?? [];

    if (services.length === 0) {
      loadingEl.textContent = "監視対象が登録されていません。src/config.ts の SERVICES を編集してください。";
      return;
    }

    // 各サービスの履歴を並列取得
    const histories = await Promise.all(
      services.map((s) =>
        fetchJson(`/api/history?service=${encodeURIComponent(s.id)}&bucket=${bucketMinutes}&days=${days}`).catch((e) => {
          console.error(e);
          return null;
        })
      )
    );

    loadingEl.hidden = true;
    lastUpdatedEl.textContent = `最終更新: ${new Date(statusData.generatedAt).toLocaleString("ja-JP")}`;

    services.forEach((svc, idx) => {
      const hist = histories[idx];
      const card = document.createElement("div");
      card.className = "card";

      const last = svc.lastCheck;
      const isUp = last ? last.ok : null;
      const badgeClass = isUp === true ? "badge-up" : isUp === false ? "badge-down" : "badge-unknown";
      const badgeText = isUp === true ? "● 稼働中" : isUp === false ? "● 障害" : "● 不明";

      const uptime24 = svc.uptime?.["24h"];
      const uptime7d = svc.uptime?.["7d"];
      const uptime90d = svc.uptime?.["90d"];

      card.innerHTML = `
        <div class="card-header">
          <div>
            <div class="service-name">${escapeHtml(svc.name)}</div>
            <div class="service-host">${escapeHtml(svc.host)}</div>
          </div>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="meta">
          <span>24h: <strong>${formatUptime(uptime24)}</strong></span>
          <span>7d: <strong>${formatUptime(uptime7d)}</strong></span>
          <span>90d: <strong>${formatUptime(uptime90d)}</strong></span>
          <span>最終チェック: <strong>${last ? formatTime(last.timestamp) : "-"}</strong> / ${last ? formatLatency(last.latencyMs) : "-"} ${last?.status ? `(${last.status})` : ""} ${last?.error ? `<span style="color:#ef4444">${escapeHtml(last.error)}</span>` : ""}</span>
        </div>
        <div class="timeline">
          <div class="grid" data-service="${svc.id}"></div>
          <div class="timeline-labels">
            <span>${hist ? formatTime(hist.buckets[0]?.start) : ""}</span>
            <span>${hist ? formatTime(hist.buckets[hist.buckets.length - 1]?.end) : ""}</span>
          </div>
          <div class="bar-summary">${hist ? `${hist.totalChecks} checks / ${bucketMinutes}分バケット × ${days}日` : ""}</div>
        </div>
      `;

      servicesEl.appendChild(card);

      // グリッド描画
      const grid = card.querySelector(".grid");
      if (hist && hist.buckets) {
        hist.buckets.forEach((b) => {
          const div = document.createElement("div");
          div.className = `box ${bucketColor(b)}`;
          // degradedの場合はuptimeで色を微調整
          if (b.status === "degraded" && b.uptime != null) {
            // 0.5-1.0 を yellow -> orange に補間
            const t = (b.uptime - 0.5) / 0.5; // 0..1
            // yellow #eab308 -> orange #f97316
            // 簡易: uptime低いほど赤寄り
            if (b.uptime < 0.8) div.style.background = "#f97316";
            else if (b.uptime < 0.95) div.style.background = "#f59e0b";
          }
          div.dataset.start = String(b.start);
          div.dataset.end = String(b.end);
          div.dataset.uptime = b.uptime != null ? String(b.uptime) : "";
          div.dataset.total = String(b.total);
          div.dataset.up = String(b.up);
          div.dataset.down = String(b.down);
          div.dataset.latency = String(b.avgLatency ?? "");
          div.dataset.status = b.status;
          div.addEventListener("mouseenter", showTooltip);
          div.addEventListener("mouseleave", hideTooltip);
          div.addEventListener("mousemove", moveTooltip);
          grid.appendChild(div);
        });
      }
    });
  } catch (e) {
    loadingEl.textContent = "読み込み失敗: " + e.message;
    console.error(e);
  }
}

function showTooltip(e) {
  const el = e.currentTarget;
  const start = parseInt(el.dataset.start, 10);
  const end = parseInt(el.dataset.end, 10);
  const uptime = el.dataset.uptime ? parseFloat(el.dataset.uptime) : null;
  const total = el.dataset.total;
  const up = el.dataset.up;
  const down = el.dataset.down;
  const latency = el.dataset.latency;
  const status = el.dataset.status;

  const statusJa = status === "up" ? "正常" : status === "down" ? "障害" : status === "degraded" ? "部分障害" : "データなし";

  tooltipEl.innerHTML = `
    <div><strong>${formatTime(start)} – ${new Date(end).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</strong></div>
    <div>状態: ${statusJa}</div>
    ${uptime != null ? `<div>稼働率: ${formatUptime(uptime)} (${up}/${total})</div>` : `<div>チェック: ${total}件</div>`}
    ${down !== "0" ? `<div style="color:#fca5a5">障害: ${down}件</div>` : ""}
    ${latency ? `<div>平均レイテンシ: ${latency}ms</div>` : ""}
  `;
  tooltipEl.hidden = false;
  moveTooltip(e);
}
function hideTooltip() {
  tooltipEl.hidden = true;
}
function moveTooltip(e) {
  const x = e.clientX + 12;
  const y = e.clientY + 12;
  // 画面端で反転
  const rect = tooltipEl.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - 8) left = e.clientX - rect.width - 12;
  if (top + rect.height > window.innerHeight - 8) top = e.clientY - rect.height - 12;
  tooltipEl.style.left = left + "px";
  tooltipEl.style.top = top + "px";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 初回ロード + 60秒ごと自動更新
load();
setInterval(load, 60 * 1000);
