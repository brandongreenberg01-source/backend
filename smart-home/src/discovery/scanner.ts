import { ssdpScan } from './ssdp';
import { mdnsScan } from './mdns';
import { discover as kasaDiscover } from '../adapters/kasa';
import type { DeviceRegistry } from '../registry';
import type { DiscoveredDevice } from '../types';

function guessName(hints: Record<string, string>, names: string[]): string | undefined {
  const instance = names.find((n) => n.includes('._') && !n.startsWith('_'));
  if (instance) return instance.split('._')[0];
  return hints['SERVER']?.split(' ')[0];
}

/**
 * Sweep the local network three ways at once and merge the results by IP:
 *  - Kasa UDP broadcast (identifies TP-Link devices exactly)
 *  - SSDP/UPnP M-SEARCH (routers, TVs, hubs, many wifi devices)
 *  - mDNS/Bonjour (Chromecast, HomeKit, Hue, Sonoff, printers...)
 * Anything that answers shows up, even brands we can't control yet.
 */
export async function scanNetwork(registry: DeviceRegistry): Promise<DiscoveredDevice[]> {
  const [kasa, ssdp, mdns] = await Promise.all([kasaDiscover(), ssdpScan(), mdnsScan()]);

  const byIp = new Map<string, DiscoveredDevice>();
  const upsert = (ip: string): DiscoveredDevice => {
    let entry = byIp.get(ip);
    if (!entry) {
      entry = { ip, sources: [], hints: {} };
      byIp.set(ip, entry);
    }
    return entry;
  };

  for (const [ip, info] of kasa) {
    const entry = upsert(ip);
    entry.sources.push('kasa');
    entry.name = info.alias || info.model;
    entry.hints['model'] = info.model ?? '';
    entry.managedId = info.deviceId ? `kasa:${info.deviceId}` : undefined;
  }

  for (const result of ssdp) {
    const entry = upsert(result.ip);
    entry.sources.push('ssdp');
    for (const key of ['SERVER', 'ST', 'LOCATION', 'USN']) {
      if (result.headers[key]) entry.hints[key] = result.headers[key];
    }
  }

  for (const result of mdns) {
    const entry = upsert(result.ip);
    entry.sources.push('mdns');
    entry.hints['services'] = result.names.slice(0, 8).join(', ');
  }

  const managedIps = new Map(registry.list().flatMap((d) => (d.ip ? [[d.ip, d.id] as const] : [])));
  for (const entry of byIp.values()) {
    entry.managedId ??= managedIps.get(entry.ip);
    entry.name ??= guessName(entry.hints, entry.hints['services']?.split(', ') ?? []);
  }

  return [...byIp.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}
