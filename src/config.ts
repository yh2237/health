export interface MonitoredService {
  id: string;
  name: string;
  url: string;
  timeoutMs?: number;
}

export const SERVICES: MonitoredService[] = [
  {
    id: "example",
    name: "Example Service",
    url: "https://example.yourdomain.com/",
    timeoutMs: 10000,
  },
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

export const RETENTION_DAYS = 90;