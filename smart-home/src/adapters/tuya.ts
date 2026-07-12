import crypto from 'node:crypto';
import { config } from '../config';
import { hsvToRgb, rgbToHsv, clamp } from '../utils/color';
import type { Adapter, Device, DeviceState, RGB, Capability } from '../types';

const REGION_HOSTS: Record<string, string> = {
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

// Tuya status codes that mean "power" on lights, plugs and switches.
const SWITCH_CODES = ['switch_led', 'switch', 'switch_1'];
const LIGHT_CATEGORIES = new Set(['dj', 'dd', 'xdd', 'fwd', 'dc']);

export interface TuyaSignInput {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  t: string;
  nonce?: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path including query string, e.g. /v1.0/token?grant_type=1 */
  path: string;
  body?: string;
}

/**
 * Canonical string per Tuya OpenAPI v2 signing:
 * METHOD \n sha256(body) \n signed-headers (empty) \n path-with-query
 */
export function buildStringToSign({ method, path, body }: Pick<TuyaSignInput, 'method' | 'path' | 'body'>): string {
  const contentHash = crypto.createHash('sha256').update(body ?? '').digest('hex');
  return [method, contentHash, '', path].join('\n');
}

/** HMAC-SHA256(clientId + accessToken? + t + nonce? + stringToSign, secret), uppercase hex. */
export function buildSignature(input: TuyaSignInput): string {
  const str =
    input.clientId + (input.accessToken ?? '') + input.t + (input.nonce ?? '') + buildStringToSign(input);
  return crypto.createHmac('sha256', input.clientSecret).update(str).digest('hex').toUpperCase();
}

interface TuyaStatus {
  code: string;
  value: unknown;
}

interface TuyaDevice {
  id: string;
  name: string;
  category?: string;
  product_name?: string;
  online?: boolean;
  status?: TuyaStatus[];
}

export class TuyaAdapter implements Adapter {
  readonly brand = 'tuya';
  private token = '';
  private tokenExpiresAt = 0;
  /** nativeId -> status codes seen on the device, used to pick command codes */
  private codes = new Map<string, Set<string>>();

  enabled(): boolean {
    return Boolean(config.tuya.clientId && config.tuya.clientSecret);
  }

  private get host(): string {
    return REGION_HOSTS[config.tuya.region] ?? REGION_HOSTS.us;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: object, withToken = true): Promise<any> {
    if (withToken) await this.ensureToken();
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const sign = buildSignature({
      clientId: config.tuya.clientId,
      clientSecret: config.tuya.clientSecret,
      accessToken: withToken ? this.token : undefined,
      t,
      nonce,
      method,
      path,
      body: bodyStr,
    });
    const headers: Record<string, string> = {
      client_id: config.tuya.clientId,
      sign,
      t,
      nonce,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    };
    if (withToken) headers.access_token = this.token;

    const res = await fetch(`${this.host}${path}`, { method, headers, body: bodyStr });
    const json: any = await res.json();
    if (!json.success) {
      throw new Error(`tuya: ${path} failed (${json.code}): ${json.msg}`);
    }
    return json.result;
  }

  private async ensureToken(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) return;
    const result = await this.request('GET', '/v1.0/token?grant_type=1', undefined, false);
    this.token = result.access_token;
    // expire_time is in seconds; renew a minute early.
    this.tokenExpiresAt = Date.now() + (result.expire_time - 60) * 1000;
  }

  private rememberCodes(nativeId: string, status: TuyaStatus[] | undefined): void {
    if (!status?.length) return;
    this.codes.set(nativeId, new Set(status.map((s) => s.code)));
  }

  private codeFor(device: Device, candidates: string[]): string | undefined {
    const known = this.codes.get(device.nativeId);
    if (!known) return candidates[0];
    return candidates.find((c) => known.has(c));
  }

  private toState(device: TuyaDevice | Device, status: TuyaStatus[]): DeviceState {
    const state: DeviceState = { online: (device as TuyaDevice).online ?? true };
    for (const s of status) {
      if (SWITCH_CODES.includes(s.code) && typeof s.value === 'boolean') state.on = s.value;
      if (s.code === 'bright_value_v2' && typeof s.value === 'number') {
        state.brightness = Math.round((s.value / 1000) * 100);
      } else if (s.code === 'bright_value' && typeof s.value === 'number') {
        state.brightness = Math.round((s.value / 255) * 100);
      }
      if ((s.code === 'colour_data_v2' || s.code === 'colour_data') && typeof s.value === 'string') {
        try {
          const { h, s: sat, v } = JSON.parse(s.value);
          const scale = s.code === 'colour_data_v2' ? 1000 : 255;
          state.color = hsvToRgb(h, sat / scale, v / scale);
        } catch {
          /* non-JSON colour payload */
        }
      }
    }
    return state;
  }

  async listDevices(): Promise<Device[]> {
    const result = await this.request('GET', '/v1.0/iot-01/associated-users/devices?size=100');
    const items: TuyaDevice[] = result.devices ?? [];
    return items.map((d) => {
      this.rememberCodes(d.id, d.status);
      const codes = new Set((d.status ?? []).map((s) => s.code));
      const capabilities: Capability[] = [];
      if (SWITCH_CODES.some((c) => codes.has(c))) capabilities.push('power');
      if (codes.has('bright_value') || codes.has('bright_value_v2')) capabilities.push('brightness');
      if (codes.has('colour_data') || codes.has('colour_data_v2')) capabilities.push('color');
      const isLight = LIGHT_CATEGORIES.has(d.category ?? '') || codes.has('switch_led');
      return {
        id: `tuya:${d.id}`,
        nativeId: d.id,
        name: d.name || d.product_name || d.id,
        brand: this.brand,
        type: isLight ? 'light' : capabilities.includes('power') ? 'plug' : 'unknown',
        model: d.product_name,
        capabilities,
        state: this.toState(d, d.status ?? []),
      } satisfies Device;
    });
  }

  async getState(device: Device): Promise<DeviceState> {
    const status: TuyaStatus[] = await this.request('GET', `/v1.0/iot-03/devices/${device.nativeId}/status`);
    this.rememberCodes(device.nativeId, status);
    return this.toState(device, status);
  }

  private async sendCommands(device: Device, commands: Array<{ code: string; value: unknown }>): Promise<void> {
    await this.request('POST', `/v1.0/iot-03/devices/${device.nativeId}/commands`, { commands });
  }

  async setPower(device: Device, on: boolean): Promise<void> {
    const code = this.codeFor(device, SWITCH_CODES) ?? 'switch_1';
    await this.sendCommands(device, [{ code, value: on }]);
  }

  async setBrightness(device: Device, percent: number): Promise<void> {
    const pct = clamp(percent, 1, 100);
    const code = this.codeFor(device, ['bright_value_v2', 'bright_value']) ?? 'bright_value_v2';
    const value =
      code === 'bright_value_v2' ? clamp(Math.round(pct * 10), 10, 1000) : clamp(Math.round((pct / 100) * 255), 25, 255);
    await this.sendCommands(device, [{ code, value }]);
  }

  async setColor(device: Device, rgb: RGB): Promise<void> {
    const { h, s, v } = rgbToHsv(rgb);
    const code = this.codeFor(device, ['colour_data_v2', 'colour_data']) ?? 'colour_data_v2';
    const scale = code === 'colour_data_v2' ? 1000 : 255;
    const value = {
      h: Math.round(h),
      s: Math.round(s * scale),
      v: Math.round(v * scale),
    };
    const workMode = this.codeFor(device, ['work_mode']);
    const commands: Array<{ code: string; value: unknown }> = [{ code, value }];
    if (workMode) commands.unshift({ code: workMode, value: 'colour' });
    await this.sendCommands(device, commands);
  }
}
