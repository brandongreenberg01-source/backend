import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import express from 'express';
import { hsvToRgb, rgbToHsv } from '../utils/color';
import type { DeviceRegistry } from '../registry';
import type { Device } from '../types';

/**
 * Emulated Philips Hue bridge, the classic ha-bridge/fauxmo trick:
 * Echo devices discover local Hue bridges natively (no skill, no AWS),
 * so we answer SSDP discovery and speak just enough of the Hue v1 REST
 * API for Alexa to enumerate and control every device in the registry.
 *
 * NOTE: Echo gen 3+ only pairs with bridges listening on port 80.
 */

function primaryIp(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

/** Stable fake MAC derived from hostname, so the bridge id survives restarts. */
function bridgeMac(): string {
  const hash = crypto.createHash('sha256').update(os.hostname()).digest('hex');
  return `b8:27:eb:${hash.slice(0, 2)}:${hash.slice(2, 4)}:${hash.slice(4, 6)}`;
}

export class HueBridge {
  private readonly mac = bridgeMac();
  private readonly bridgeId: string;
  private lightIds = new Map<string, string>(); // hue numeric id -> device id
  private nextId = 1;
  private ssdpSocket?: dgram.Socket;

  constructor(private registry: DeviceRegistry, private port: number) {
    const mac12 = this.mac.replaceAll(':', '').toUpperCase();
    this.bridgeId = mac12.slice(0, 6) + 'FFFE' + mac12.slice(6);
  }

  private hueIdFor(device: Device): string {
    for (const [hueId, deviceId] of this.lightIds) {
      if (deviceId === device.id) return hueId;
    }
    const hueId = String(this.nextId++);
    this.lightIds.set(hueId, device.id);
    return hueId;
  }

  private toHueLight(device: Device) {
    const color = device.capabilities.includes('color');
    const dimmable = device.capabilities.includes('brightness');
    const state = device.state;
    const { h, s } = state.color ? rgbToHsv(state.color) : { h: 0, s: 0 };
    return {
      state: {
        on: state.on ?? false,
        bri: Math.max(1, Math.round(((state.brightness ?? 100) / 100) * 254)),
        hue: Math.round((h / 360) * 65535),
        sat: Math.round(s * 254),
        effect: 'none',
        colormode: 'hs',
        alert: 'none',
        mode: 'homeautomation',
        reachable: state.online,
      },
      type: color ? 'Extended color light' : dimmable ? 'Dimmable light' : 'On/off plug-in unit',
      name: device.name,
      modelid: color ? 'LCT015' : dimmable ? 'LWB010' : 'LOM001',
      manufacturername: 'Signify Netherlands B.V.',
      productname: color ? 'Hue color lamp' : dimmable ? 'Hue white lamp' : 'Hue smart plug',
      uniqueid: crypto.createHash('sha256').update(device.id).digest('hex').slice(0, 16).replace(/(..)/g, '$1:').slice(0, -1) + '-0b',
      swversion: '1.0.0',
    };
  }

  private lights(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const device of this.registry.list()) {
      if (!device.capabilities.includes('power')) continue;
      out[this.hueIdFor(device)] = this.toHueLight(device);
    }
    return out;
  }

  private bridgeConfig() {
    return {
      name: 'Smart Home Hub',
      bridgeid: this.bridgeId,
      mac: this.mac,
      modelid: 'BSB002',
      swversion: '01041302',
      apiversion: '1.16.0',
      datastoreversion: '90',
      factorynew: false,
      replacesbridgeid: null,
      dhcp: true,
      linkbutton: true,
      portalservices: false,
      ipaddress: primaryIp(),
      netmask: '255.255.255.0',
      gateway: primaryIp(),
      zigbeechannel: 15,
      timezone: 'UTC',
      UTC: new Date().toISOString().slice(0, 19),
      localtime: new Date().toISOString().slice(0, 19),
      whitelist: { smarthomehub: { name: 'smart-home-hub' } },
    };
  }

  private descriptionXml(): string {
    const ip = primaryIp();
    return `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>http://${ip}:${this.port}/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
    <friendlyName>Philips hue (${ip})</friendlyName>
    <manufacturer>Royal Philips Electronics</manufacturer>
    <manufacturerURL>http://www.philips.com</manufacturerURL>
    <modelDescription>Philips hue Personal Wireless Lighting</modelDescription>
    <modelName>Philips hue bridge 2015</modelName>
    <modelNumber>BSB002</modelNumber>
    <serialNumber>${this.mac.replaceAll(':', '')}</serialNumber>
    <UDN>uuid:2f402f80-da50-11e1-9b23-${this.mac.replaceAll(':', '')}</UDN>
  </device>
</root>`;
  }

  private async applyState(deviceId: string, hueId: string, body: Record<string, unknown>): Promise<unknown[]> {
    const responses: unknown[] = [];
    const ok = (key: string, value: unknown) => responses.push({ success: { [`/lights/${hueId}/state/${key}`]: value } });

    if (typeof body.on === 'boolean' && body.bri === undefined && body.hue === undefined) {
      await this.registry.setPower(deviceId, body.on);
      ok('on', body.on);
      return responses;
    }
    if (typeof body.on === 'boolean' && body.on === false) {
      await this.registry.setPower(deviceId, false);
      ok('on', false);
      return responses;
    }
    if (typeof body.hue === 'number' || typeof body.sat === 'number') {
      const device = this.registry.get(deviceId);
      const current = device?.state.color ? rgbToHsv(device.state.color) : { h: 0, s: 1, v: 1 };
      const h = typeof body.hue === 'number' ? (body.hue / 65535) * 360 : current.h;
      const s = typeof body.sat === 'number' ? body.sat / 254 : current.s;
      const v = typeof body.bri === 'number' ? body.bri / 254 : 1;
      await this.registry.setColor(deviceId, hsvToRgb(h, s, v));
      if (typeof body.hue === 'number') ok('hue', body.hue);
      if (typeof body.sat === 'number') ok('sat', body.sat);
      if (typeof body.bri === 'number') ok('bri', body.bri);
      if (typeof body.on === 'boolean') ok('on', body.on);
      return responses;
    }
    if (typeof body.bri === 'number') {
      await this.registry.setBrightness(deviceId, Math.round((body.bri / 254) * 100));
      ok('bri', body.bri);
      if (typeof body.on === 'boolean') ok('on', body.on);
      return responses;
    }
    if (typeof body.on === 'boolean') {
      await this.registry.setPower(deviceId, body.on);
      ok('on', body.on);
    }
    return responses;
  }

  private buildApp(): express.Express {
    const app = express();
    app.use(express.json({ type: () => true }));

    app.get('/description.xml', (_req, res) => {
      res.type('application/xml').send(this.descriptionXml());
    });

    // Pairing: Alexa "presses the link button" by POSTing here.
    app.post('/api', (_req, res) => {
      res.json([{ success: { username: 'smarthomehub' } }]);
    });

    app.get('/api/:user/lights', (_req, res) => res.json(this.lights()));

    app.get('/api/:user/lights/:id', (req, res) => {
      const deviceId = this.lightIds.get(req.params.id);
      const device = deviceId ? this.registry.get(deviceId) : undefined;
      if (!device) {
        res.json([{ error: { type: 3, address: `/lights/${req.params.id}`, description: 'resource not available' } }]);
        return;
      }
      res.json(this.toHueLight(device));
    });

    app.put('/api/:user/lights/:id/state', async (req, res) => {
      const deviceId = this.lightIds.get(req.params.id);
      if (!deviceId || !this.registry.get(deviceId)) {
        res.json([{ error: { type: 3, address: `/lights/${req.params.id}`, description: 'resource not available' } }]);
        return;
      }
      try {
        res.json(await this.applyState(deviceId, req.params.id, req.body ?? {}));
      } catch (err) {
        res.json([{ error: { type: 901, address: `/lights/${req.params.id}`, description: String(err) } }]);
      }
    });

    // Some Echo firmwares fetch config unauthenticated, some fetch the full datastore.
    app.get(['/api/config', '/api/:user/config'], (_req, res) => res.json(this.bridgeConfig()));
    app.get('/api/:user', (_req, res) =>
      res.json({ lights: this.lights(), config: this.bridgeConfig(), groups: {}, scenes: {}, schedules: {}, sensors: {} }),
    );

    return app;
  }

  private startSsdpResponder(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.ssdpSocket = socket;

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!text.startsWith('M-SEARCH') || !text.includes('ssdp:discover')) return;
      const stMatch = /^ST:\s*(.*)$/im.exec(text);
      const st = (stMatch?.[1] ?? '').trim();
      const interesting =
        st === 'ssdp:all' || st === 'upnp:rootdevice' || st.includes('device:basic') || st.includes('hue');
      if (!interesting) return;

      const ip = primaryIp();
      const responseSt = st === 'ssdp:all' || st === '' ? 'urn:schemas-upnp-org:device:basic:1' : st;
      const response = [
        'HTTP/1.1 200 OK',
        'CACHE-CONTROL: max-age=100',
        'EXT:',
        `LOCATION: http://${ip}:${this.port}/description.xml`,
        'SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.26.0',
        `hue-bridgeid: ${this.bridgeId}`,
        `ST: ${responseSt}`,
        `USN: uuid:2f402f80-da50-11e1-9b23-${this.mac.replaceAll(':', '')}::${responseSt}`,
        '',
        '',
      ].join('\r\n');
      socket.send(response, rinfo.port, rinfo.address);
    });

    socket.on('error', (err) => {
      console.warn(`[alexa] SSDP responder error: ${err.message}`);
    });

    socket.bind(1900, () => {
      try {
        socket.addMembership('239.255.255.250');
      } catch {
        /* no multicast on this interface (e.g. containers) */
      }
    });
  }

  start(): void {
    const app = this.buildApp();
    app
      .listen(this.port, () => {
        console.log(`[alexa] Emulated Hue bridge on port ${this.port} — say "Alexa, discover devices"`);
      })
      .on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EACCES') {
          console.warn(
            `[alexa] Cannot bind port ${this.port} (needs elevated privileges). ` +
              `Run with sudo, or: sudo setcap 'cap_net_bind_service=+ep' $(which bun). ` +
              `Echo gen 3+ requires port 80 for Hue discovery.`,
          );
        } else {
          console.warn(`[alexa] Hue bridge failed to start: ${err.message}`);
        }
      });
    this.startSsdpResponder();
  }

  stop(): void {
    this.ssdpSocket?.close();
  }
}
