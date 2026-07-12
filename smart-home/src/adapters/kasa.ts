import net from 'node:net';
import dgram from 'node:dgram';
import { config } from '../config';
import { rgbToHsv, hsvToRgb, clamp } from '../utils/color';
import type { Adapter, Device, DeviceState, RGB, Capability } from '../types';

const KASA_PORT = 9999;
const SYSINFO_CMD = { system: { get_sysinfo: {} } };

/**
 * TP-Link "autokey" XOR cipher. Every Kasa device speaks JSON obfuscated
 * with this rolling XOR, keyed off the previous ciphertext byte (seed 171).
 */
export function encrypt(input: string): Buffer {
  const buf = Buffer.from(input, 'utf8');
  let key = 171;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = buf[i] ^ key;
    key = buf[i];
  }
  return buf;
}

export function decrypt(buf: Buffer): string {
  const out = Buffer.alloc(buf.length);
  let key = 171;
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key;
    key = buf[i];
  }
  return out.toString('utf8');
}

interface SysInfo {
  alias?: string;
  deviceId?: string;
  model?: string;
  mic_type?: string;
  type?: string;
  relay_state?: number;
  brightness?: number;
  is_dimmable?: number;
  is_color?: number;
  light_state?: {
    on_off?: number;
    brightness?: number;
    hue?: number;
    saturation?: number;
    dft_on_state?: { brightness?: number; hue?: number; saturation?: number };
  };
}

function isBulb(info: SysInfo): boolean {
  return /SMARTBULB/i.test(info.mic_type ?? info.type ?? '');
}

/** Send one command over TCP (4-byte big-endian length prefix + ciphertext). */
export async function sendCommand(ip: string, command: object, timeoutMs = 4000): Promise<any> {
  const payload = encrypt(JSON.stringify(command));
  const framed = Buffer.concat([Buffer.alloc(4), payload]);
  framed.writeUInt32BE(payload.length, 0);

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port: KASA_PORT });
    const chunks: Buffer[] = [];
    let expected = -1;

    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`kasa: timeout talking to ${ip}`)));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(framed));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (expected < 0 && buf.length >= 4) expected = buf.readUInt32BE(0);
      if (expected >= 0 && buf.length >= expected + 4) {
        socket.end();
        try {
          resolve(JSON.parse(decrypt(buf.subarray(4, 4 + expected))));
        } catch (err) {
          reject(err as Error);
        }
      }
    });
  });
}

/** UDP broadcast discovery: every Kasa device answers get_sysinfo on port 9999. */
export function discover(timeoutMs = 2500): Promise<Map<string, SysInfo>> {
  return new Promise((resolve) => {
    const found = new Map<string, SysInfo>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(found);
    };

    socket.on('error', done);
    socket.on('message', (msg, rinfo) => {
      try {
        const info = JSON.parse(decrypt(msg))?.system?.get_sysinfo;
        if (info) found.set(rinfo.address, info);
      } catch {
        /* not a kasa reply */
      }
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        const probe = encrypt(JSON.stringify(SYSINFO_CMD));
        socket.send(probe, KASA_PORT, '255.255.255.255');
      } catch {
        done();
        return;
      }
      setTimeout(done, timeoutMs);
    });
  });
}

export class KasaAdapter implements Adapter {
  readonly brand = 'kasa';
  /** nativeId (deviceId) -> last known IP */
  private ips = new Map<string, string>();

  enabled(): boolean {
    return config.kasa.enabled;
  }

  private toDevice(ip: string, info: SysInfo): Device {
    const bulb = isBulb(info);
    const capabilities: Capability[] = ['power'];
    if (bulb ? info.is_dimmable !== 0 : info.brightness !== undefined) capabilities.push('brightness');
    if (bulb && info.is_color) capabilities.push('color');
    const nativeId = info.deviceId ?? ip;
    this.ips.set(nativeId, ip);
    return {
      id: `kasa:${nativeId}`,
      nativeId,
      name: info.alias || info.model || `Kasa @ ${ip}`,
      brand: this.brand,
      type: bulb ? 'light' : 'plug',
      model: info.model,
      ip,
      capabilities,
      state: this.toState(info),
    };
  }

  private toState(info: SysInfo): DeviceState {
    if (isBulb(info)) {
      const ls = info.light_state ?? {};
      const on = ls.on_off === 1;
      // When off, live color/brightness values move to dft_on_state.
      const src = on ? ls : { ...ls.dft_on_state };
      const state: DeviceState = { online: true, on, brightness: src.brightness };
      if (info.is_color && src.hue !== undefined) {
        state.color = hsvToRgb(src.hue, (src.saturation ?? 100) / 100, (src.brightness ?? 100) / 100);
      }
      return state;
    }
    return { online: true, on: info.relay_state === 1, brightness: info.brightness };
  }

  async listDevices(): Promise<Device[]> {
    const found = await discover();
    return [...found.entries()].map(([ip, info]) => this.toDevice(ip, info));
  }

  private ipFor(device: Device): string {
    const ip = this.ips.get(device.nativeId) ?? device.ip;
    if (!ip) throw new Error(`kasa: no known IP for ${device.id} — run a scan first`);
    return ip;
  }

  async getState(device: Device): Promise<DeviceState> {
    try {
      const res = await sendCommand(this.ipFor(device), SYSINFO_CMD);
      const info: SysInfo | undefined = res?.system?.get_sysinfo;
      if (!info) throw new Error('kasa: malformed sysinfo reply');
      return this.toState(info);
    } catch {
      return { ...device.state, online: false };
    }
  }

  async setPower(device: Device, on: boolean): Promise<void> {
    const cmd =
      device.type === 'light'
        ? { 'smartlife.iot.smartbulb.lightingservice': { transition_light_state: { on_off: on ? 1 : 0 } } }
        : { system: { set_relay_state: { state: on ? 1 : 0 } } };
    await sendCommand(this.ipFor(device), cmd);
  }

  async setBrightness(device: Device, percent: number): Promise<void> {
    const value = clamp(Math.round(percent), 1, 100);
    const cmd =
      device.type === 'light'
        ? {
            'smartlife.iot.smartbulb.lightingservice': {
              transition_light_state: { on_off: 1, ignore_default: 1, brightness: value },
            },
          }
        : { 'smartlife.iot.dimmer': { set_brightness: { brightness: value } } };
    await sendCommand(this.ipFor(device), cmd);
  }

  async setColor(device: Device, rgb: RGB): Promise<void> {
    const { h, s, v } = rgbToHsv(rgb);
    await sendCommand(this.ipFor(device), {
      'smartlife.iot.smartbulb.lightingservice': {
        transition_light_state: {
          on_off: 1,
          ignore_default: 1,
          color_temp: 0,
          hue: Math.round(h),
          saturation: Math.round(s * 100),
          brightness: clamp(Math.round(v * 100), 1, 100),
        },
      },
    });
  }
}
