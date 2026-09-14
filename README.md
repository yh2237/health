# Health Monitor - 自宅サーバー死活監視

Cloudflare Workers + D1 + Cron で動く、自宅サーバーの死活監視。Cloudflare Tunnel経由で公開しているサービスの監視に特化（Tunnelエラーページをダウン判定）。

## 特徴

- **5分間隔の自動チェック** (`wrangler.jsonc:15` `*/5 * * * *`)
- **Tunnelエラーページ検知**: `src/checker.ts:9` で HTTPステータス + ボディキーワード (`cloudflare tunnel`, `unable to reach the origin`, `bad gateway`, `error 1033` 等) を検知。200でもエラーページならダウン扱い
- **D1保存**: 時系列をSQLiteで保持、90日自動削除、SQLで集計
- **フロント**: ボックスグリッド（30分/1時間切替、7/30/90日切替）、色で稼働率可視化

## 構成

```
src/config.ts        # 監視対象定義
src/checker.ts       # fetch + Tunnel判定
src/index.ts         # Hono API + cron + D1
migrations/0001_init.sql  # D1スキーマ
public/              # フロント (index.html/style.css/app.js)
wrangler.jsonc
```

## 設定

### 1) 監視対象を追加

`src/config.ts:15`

```ts
export const SERVICES = [
  { id: "plex", name: "Plex", url: "https://plex.example.com/" },
  { id: "ha", name: "Home Assistant", url: "https://ha.example.com/" },
];
```

### 2) D1作成

```bash
npx wrangler d1 create health-monitor
# 出力された database_id を wrangler.jsonc:10 の database_id / preview_database_id に貼り付け
npx wrangler d1 migrations apply health-monitor --local   # ローカル確認用
npx wrangler d1 migrations apply health-monitor --remote  # 本番
```

Workers Builds（Git連携）の場合、ダッシュボードでも可:
Workers & Pages > D1 > Create → Workers > 対象Worker > Settings > Bindings > D1 Database > `DB` でバインド。Migrationは `migrations/` が自動適用される

### 3) デプロイ（Git連携 推奨）

1. GitHubにpush
2. Cloudflareダッシュボード > Workers & Pages > Create > Connect to Git
3. リポジトリ選択（ビルド設定デフォルト）
4. 初回デプロイ後、BindingsでD1 (`DB`) を設定し再デプロイ

手動:

```bash
npm install
npx wrangler deploy
```

### 4) 動作確認

- `https://<worker>.workers.dev/` でフロント
- `https://<worker>.workers.dev/api/status` でJSON
- 手動チェック: `POST /api/check` または `GET /api/check?service=plex`

## API

- `GET /api/services`
- `GET /api/status` - 全サービスの最新状態 + 24h/7d/30d/90d稼働率（`src/index.ts:95` でSQL集計）
- `GET /api/history?service=<id>&bucket=30|60&days=7|30|90` - バケット集計 + 直近100件
- `POST /api/check?service=<id>` / `GET /api/check` - 手動トリガー
- `GET /api/health`

## D1スキーマ

`migrations/0001_init.sql`

```sql
CREATE TABLE checks (
  service_id TEXT, timestamp INTEGER, ok INTEGER, status INTEGER,
  latency_ms INTEGER, error TEXT, is_tunnel_error INTEGER
);
CREATE INDEX idx_checks_service_time ON checks(service_id, timestamp);
```

Cron毎 (`src/index.ts:206`) に `INSERT` し、`cleanupOld` で90日以前を `DELETE`

## ローカル開発

```bash
npm install --legacy-peer-deps
npm run dev
# http://localhost:8787
# --local でD1はローカルSQLite (.wrangler/state) に保存
```
