import crypto from 'node:crypto';
import { config } from '../config';
import { rgbToInt, intToRgb, clamp } from '../utils/color';
import type { Adapter, Device, DeviceState, RGB, Capability } from '../types';

const BASE = 'https://openapi.api.govee.com';

interface GoveeCapability {
  type: string;
  instance: string;
  state?: { value?: unknown };
}

interface GoveeDevice {
  sku: string;
  device: string;
  deviceName?: string;
  type?: string;
  capabilities?: GoveeCapability[];
}

export class GoveeAdapter implements Adapter {
  readonly brand = 'govee';
  /** nativeId -> sku, needed for every control/state call */
  private skus = new Map<string, string>();

  enabled(): boolean {
    return Boolean(config.govee.apiKey);
  }

  private async request(path: string, body?: object): Promise<any> {
    const res = await fetch(`${BASE}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Govee-API-Key': config.govee.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`govee: ${path} failed with HTTP ${res.status}`);
    const json: any = await res.json();
    if (json.code !== undefined && json.code !== 200) {
      throw new Error(`govee: ${path} returned code ${json.code}: ${json.message ?? json.msg ?? ''}`);
    }
    return json;
  }

  private skuFor(device: Device): string {
    const sku = this.skus.get(device.nativeId) ?? device.model;
    if (!sku) throw new Error(`govee: unknown SKU for ${device.id} — refresh devices first`);
    return sku;
  }

  private async control(device: Device, type: string, instance: string, value: unknown): Promise<void> {
    await this.request('/router/api/v1/device/control', {
      requestId: crypto.randomUUID(),
      payload: {
        sku: this.skuFor(device),
        device: device.nativeId,
        capability: { type, instance, value },
      },
    });
  }

  async listDevices(): Promise<Device[]> {
    const json = await this.request('/router/api/v1/user/devices');
    const items: GoveeDevice[] = json.data ?? [];
    return items.map((d) => {
      this.skus.set(d.device, d.sku);
      const capabilities: Capability[] = [];
      for (const cap of d.capabilities ?? []) {
        if (cap.type === 'devices.capabilities.on_off') capabilities.push('power');
        if (cap.type === 'devices.capabilities.range' && cap.instance === 'brightness') capabilities.push('brightness');
        if (cap.type === 'devices.capabilities.color_setting' && cap.instance === 'colorRgb') capabilities.push('color');
      }
      const isLight = capabilities.includes('color') || capabilities.includes('brightness') || /light/i.test(d.type ?? '');
      return {
        id: `govee:${d.device}`,
        nativeId: d.device,
        name: d.deviceName || d.sku,
        brand: this.brand,
        type: isLight ? 'light' : capabilities.includes('power') ? 'plug' : 'unknown',
        model: d.sku,
        capabilities,
        state: { online: true },
      } satisfies Device;
    });
  }

  async getState(device: Device): Promise<DeviceState> {
    const json = await this.request('/router/api/v1/device/state', {
      requestId: crypto.randomUUID(),
      payload: { sku: this.skuFor(device), device: device.nativeId },
    });
    const caps: GoveeCapability[] = json.payload?.capabilities ?? [];
    const state: DeviceState = { online: true };
    for (const cap of caps) {
      const value = cap.state?.value;
      if (cap.instance === 'online') state.online = value !== false;
      if (cap.instance === 'powerSwitch') state.on = value === 1 || value === true;
      if (cap.instance === 'brightness' && typeof value === 'number') state.brightness = value;
      if (cap.instance === 'colorRgb' && typeof value === 'number') state.color = intToRgb(value);
    }
    return state;
  }

  async setPower(device: Device, on: boolean): Promise<void> {
    await this.control(device, 'devices.capabilities.on_off', 'powerSwitch', on ? 1 : 0);
  }

  async setBrightness(device: Device, percent: number): Promise<void> {
    await this.control(device, 'devices.capabilities.range', 'brightness', clamp(Math.round(percent), 1, 100));
  }

  async setColor(device: Device, rgb: RGB): Promise<void> {
    await this.control(device, 'devices.capabilities.color_setting', 'colorRgb', rgbToInt(rgb));
  }
}
