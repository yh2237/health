# Health Monitor - 自宅サーバー死活監視

Cloudflare Workers + KV + Cron で動く、自宅サーバーの死活監視サービス。Cloudflare Tunnel経由で公開しているサービスの監視に特化し、Tunnelエラーページをダウン判定する。

## 特徴

- **5分間隔の自動チェック** (Cron `*/5 * * * *`)
- **Cloudflare Tunnelエラーページ検知**: HTTPステータスだけでなく、ボディに含まれる `cloudflare tunnel / unable to reach the origin / bad gateway / error 1033` 等も検知し、200が返ってもダウン扱いにする
- **フロント**: よくあるステータスページ風のボックスグリッド（30分 / 1時間切替、7日/30日/90日切替）、色で稼働率を可視化（緑=正常、黄=部分障害、赤=障害、灰=データなし）
- **API**: `GET /api/status`, `GET /api/history`, `POST /api/check`

## 構成

```
src/
  config.ts   # 監視対象URLを定義
  checker.ts  # fetch + Tunnelエラーページ判定
  index.ts    # Hono API + cron + KV保存
public/
  index.html / style.css / app.js  # フロント
wrangler.jsonc
```

## 設定

### 1) 監視対象を追加

`src/config.ts` を編集:

```ts
export const SERVICES = [
  { id: "plex", name: "Plex", url: "https://plex.example.com/" },
  { id: "ha", name: "Home Assistant", url: "https://ha.example.com/" },
];
```

`id` は英数字と `-_` のみ。

### 2) KV作成

Cloudflareダッシュボード or wrangler:

```bash
npx wrangler kv namespace create HEALTH_KV
# 出力された id / preview_id を wrangler.jsonc の kv_namespaces に貼り付け
```

Workers Builds（Git連携デプロイ）の場合はダッシュボードで設定も可能:
Workers & Pages > 対象Worker > Settings > Bindings > KV Namespace > `HEALTH_KV` を追加

> ローカル `wrangler dev` では `--persist` を付けるとローカルKVが使われる。`wrangler.jsonc` の `REPLACE_WITH_KV_ID` のままでも dev は動くが、本番は必ず差し替えること。

### 3) デプロイ（Git連携 - 推奨）

リポジトリをGitHubにpushし、Cloudflareダッシュボードから:

1. Workers & Pages > Create > Workers > Connect to Git
2. リポジトリ選択
3. Build設定はデフォルト（`npm install` → デプロイはWorkersが自動）。`wrangler.jsonc` がそのまま使われる
4. 初回デプロイ後に Bindings (KV) を設定し、再デプロイ

手動デプロイする場合:

```bash
npm install
npx wrangler deploy
```

### 4) 動作確認

デプロイ後:

- `https://<worker>.workers.dev/` でフロントが表示される
- `https://<worker>.workers.dev/api/status` でJSONが返る
- 手動チェック: `POST https://<worker>.workers.dev/api/check` または `GET /api/check?service=plex`

## API

- `GET /api/services` - 監視対象一覧
- `GET /api/status` - 全サービスの最新状態 + 24h/7d/30d/90d稼働率
- `GET /api/history?service=<id>&bucket=30|60&days=7|30|90` - バケット集計（30分/1時間単位）と直近チェック
- `POST /api/check?service=<id>` - 手動チェックトリガー
- `GET /api/health` - Worker自身のヘルス

## KVデータ

- Key: `history:<serviceId>` -> `{ checks: CheckResult[], updatedAt }`
- 自動で90日より古いデータを削除
- Cronが5分ごとに追記

## カスタマイズ

- チェック間隔: `wrangler.jsonc` の `triggers.crons` を変更（例: `*/1 * * * *` で1分間隔）
- タイムアウト: `config.ts` の `timeoutMs`
- 保持期間: `config.ts` の `RETENTION_DAYS`

## ローカル開発

```bash
npm install
npm run dev
# http://localhost:8787
```
