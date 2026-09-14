// 監視対象サービス定義
// ここを編集して自宅サーバーのサービスURLを追加してください
// Cloudflare Tunnel経由で公開しているURLを指定

export interface MonitoredService {
  id: string;       // 一意なID (英数字と-_)
  name: string;     // 表示名
  url: string;      // 監視対象URL
  // オプション: 期待するステータスコード (デフォルト 200-299)
  // expectedStatus?: number;
  // タイムアウトms (デフォルト 10000)
  timeoutMs?: number;
}

export const SERVICES: MonitoredService[] = [
  {
    id: "example",
    name: "Example Service",
    url: "https://example.yourdomain.com/",
    timeoutMs: 10000,
  },
  // 追加例:
  // {
  //   id: "plex",
  //   name: "Plex",
  //   url: "https://plex.yourdomain.com/",
  // },
  // {
  //   id: "homeassistant",
  //   name: "Home Assistant",
  //   url: "https://ha.yourdomain.com/",
  // },
];

// チェック間隔に対応する保持期間
export const RETENTION_DAYS = 90;

// 1バケットあたりの最大チェック数 (5分間隔なら 1時間=12件, 30分=6件)
