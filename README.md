# Health Monitor - 自宅サーバー死活監視 (API only)

Cloudflare Workers + D1 + Cron で動く、自宅サーバーの死活監視API。Cloudflare Tunnel経由で公開しているサービスの監視に特化（Tunnelエラーページをダウン判定）。

フロントエンドなし。結果はAPIで取得し、別フロントやGrafana等から利用する想定。

## 構成

```
src/config.ts        # 監視対象定義
src/checker.ts       # fetch + Tunnel判定
src/index.ts         # Hono API + cron + D1
migrations/0001_init.sql  # D1スキーマ
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
# 出力された database_id を wrangler.jsonc:12 の database_id / preview_database_id に貼り付け
npx wrangler d1 migrations apply health-monitor --remote
```

Workers Builds（Git連携）の場合: ダッシュボード > D1 > Create → Workers > Settings > Bindings > D1 Database > `DB` でバインド。`migrations/` はデプロイ時に自動適用

### 3) デプロイ

```bash
npm install --legacy-peer-deps
npx wrangler deploy
# または GitHubにpush → Cloudflareダッシュボード > Workers & Pages > Connect to Git
```

## API

- `GET /` - API一覧
- `GET /api/services` - 監視対象一覧
- `GET /api/status` - 全サービスの最新状態 + 24h/7d/30d/90d稼働率 + 直近24バケット
- `GET /api/history?service=<id>&bucket=30|60&days=7|30|90` - バケット集計（30分/1時間）+ 直近100件
- `POST /api/check?service=<id>` / `GET /api/check` - 手動チェックトリガー
- `GET /api/health` - Workerヘルス

### 例

```bash
curl https://<worker>.workers.dev/api/status | jq
curl "https://<worker>.workers.dev/api/history?service=plex&bucket=60&days=7" | jq
curl -X POST https://<worker>.workers.dev/api/check
```

## 仕様

- Cron: `wrangler.jsonc:14` `*/5 * * * *` で全サービスを `src/checker.ts:28` `checkService()` でfetch
- Tunnel判定: `src/checker.ts:9` キーワード + 非200でダウン判定
- 保存: `migrations/0001_init.sql:3` `checks` テーブル、 `src/index.ts:121` で90日以前をDELETE
- 集計: `src/index.ts:139` `aggregateBuckets()` でバケット化

## ローカル開発

```bash
npm run dev
# http://localhost:8787
```
