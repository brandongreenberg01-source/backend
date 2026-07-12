import type { Adapter, Device, DeviceState, RGB } from './types';

export class DeviceRegistry {
  private adapters = new Map<string, Adapter>();
  private devices = new Map<string, Device>();
  private lastErrors: Record<string, string> = {};

  register(adapter: Adapter): void {
    if (adapter.enabled()) this.adapters.set(adapter.brand, adapter);
  }

  get enabledBrands(): string[] {
    return [...this.adapters.keys()];
  }

  get errors(): Record<string, string> {
    return { ...this.lastErrors };
  }

  list(): Device[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Device | undefined {
    return this.devices.get(id);
  }

  /** Re-enumerate every adapter. Devices that disappear are marked offline, not dropped. */
  async refresh(): Promise<Device[]> {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map(async (a) => ({ brand: a.brand, devices: await a.listDevices() })),
    );
    for (const result of results) {
      if (result.status === 'rejected') continue;
      const { brand, devices } = result.value;
      delete this.lastErrors[brand];
      const seen = new Set(devices.map((d) => d.id));
      for (const d of devices) this.devices.set(d.id, d);
      for (const existing of this.devices.values()) {
        if (existing.brand === brand && !seen.has(existing.id)) existing.state.online = false;
      }
    }
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const brand = [...this.adapters.keys()][i];
        this.lastErrors[brand] = String(result.reason?.message ?? result.reason);
      }
    }
    return this.list();
  }

  private adapterFor(device: Device): Adapter {
    const adapter = this.adapters.get(device.brand);
    if (!adapter) throw new Error(`no adapter registered for brand "${device.brand}"`);
    return adapter;
  }

  private required(id: string): Device {
    const device = this.devices.get(id);
    if (!device) throw new Error(`unknown device "${id}"`);
    return device;
  }

  async refreshState(id: string): Promise<Device> {
    const device = this.required(id);
    const state = await this.adapterFor(device).getState(device);
    device.state = state;
    return device;
  }

  async setPower(id: string, on: boolean): Promise<Device> {
    const device = this.required(id);
    await this.adapterFor(device).setPower(device, on);
    device.state.on = on;
    return device;
  }

  async setBrightness(id: string, percent: number): Promise<Device> {
    const device = this.required(id);
    const adapter = this.adapterFor(device);
    if (!adapter.setBrightness) throw new Error(`${device.brand} adapter does not support brightness`);
    await adapter.setBrightness(device, percent);
    device.state.brightness = Math.round(percent);
    device.state.on = true;
    return device;
  }

  async setColor(id: string, rgb: RGB): Promise<Device> {
    const device = this.required(id);
    const adapter = this.adapterFor(device);
    if (!adapter.setColor) throw new Error(`${device.brand} adapter does not support color`);
    await adapter.setColor(device, rgb);
    device.state.color = rgb;
    device.state.on = true;
    return device;
  }
}
