import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(): void {
  const file = path.join(import.meta.dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}
loadDotEnv();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  govee: {
    apiKey: process.env.GOVEE_API_KEY ?? '',
  },
  tuya: {
    clientId: process.env.TUYA_CLIENT_ID ?? '',
    clientSecret: process.env.TUYA_CLIENT_SECRET ?? '',
    region: process.env.TUYA_REGION ?? 'us',
  },
  kasa: {
    enabled: (process.env.KASA_ENABLED ?? 'true') !== 'false',
  },
  alexa: {
    enabled: (process.env.ALEXA_HUE_BRIDGE ?? 'true') !== 'false',
    // Echo gen 3+ only discovers Hue bridges on port 80.
    port: Number(process.env.ALEXA_HUE_PORT ?? 80),
  },
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS ?? 60_000),
};
