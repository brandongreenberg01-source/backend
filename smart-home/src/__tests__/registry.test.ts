import { describe, it, expect } from 'bun:test';
import { DeviceRegistry } from '../registry';
import type { Adapter, Device, DeviceState, RGB } from '../types';

function makeDevice(id: string, brand: string): Device {
  return {
    id: `${brand}:${id}`,
    nativeId: id,
    name: `Device ${id}`,
    brand,
    type: 'light',
    capabilities: ['power', 'brightness', 'color'],
    state: { online: true, on: false },
  };
}

class FakeAdapter implements Adapter {
  readonly brand = 'fake';
  calls: string[] = [];
  devices: Device[] = [makeDevice('a', 'fake'), makeDevice('b', 'fake')];

  enabled() {
    return true;
  }
  async listDevices() {
    this.calls.push('list');
    return this.devices.map((d) => ({ ...d, state: { ...d.state } }));
  }
  async getState(): Promise<DeviceState> {
    this.calls.push('getState');
    return { online: true, on: true, brightness: 42 };
  }
  async setPower(device: Device, on: boolean) {
    this.calls.push(`power:${device.nativeId}:${on}`);
  }
  async setBrightness(device: Device, percent: number) {
    this.calls.push(`bri:${device.nativeId}:${percent}`);
  }
  async setColor(device: Device, rgb: RGB) {
    this.calls.push(`color:${device.nativeId}:${rgb.r},${rgb.g},${rgb.b}`);
  }
}

class BrokenAdapter implements Adapter {
  readonly brand = 'broken';
  enabled() {
    return true;
  }
  async listDevices(): Promise<Device[]> {
    throw new Error('cloud is down');
  }
  async getState(): Promise<DeviceState> {
    throw new Error('cloud is down');
  }
  async setPower() {
    throw new Error('cloud is down');
  }
}

describe('DeviceRegistry', () => {
  it('only registers enabled adapters', () => {
    const registry = new DeviceRegistry();
    const disabled = new FakeAdapter();
    disabled.enabled = () => false;
    registry.register(disabled);
    expect(registry.enabledBrands).toEqual([]);
  });

  it('refresh merges devices and routes commands to the right adapter', async () => {
    const registry = new DeviceRegistry();
    const adapter = new FakeAdapter();
    registry.register(adapter);

    const devices = await registry.refresh();
    expect(devices).toHaveLength(2);

    await registry.setPower('fake:a', true);
    await registry.setBrightness('fake:b', 55);
    await registry.setColor('fake:a', { r: 10, g: 20, b: 30 });
    expect(adapter.calls).toContain('power:a:true');
    expect(adapter.calls).toContain('bri:b:55');
    expect(adapter.calls).toContain('color:a:10,20,30');

    // optimistic state updates land on the cached device
    expect(registry.get('fake:a')?.state.color).toEqual({ r: 10, g: 20, b: 30 });
    expect(registry.get('fake:b')?.state.brightness).toBe(55);
    expect(registry.get('fake:b')?.state.on).toBe(true);
  });

  it('marks devices offline when they disappear from a later refresh', async () => {
    const registry = new DeviceRegistry();
    const adapter = new FakeAdapter();
    registry.register(adapter);
    await registry.refresh();

    adapter.devices = adapter.devices.slice(0, 1); // device b disappears
    await registry.refresh();
    expect(registry.get('fake:b')?.state.online).toBe(false);
    expect(registry.get('fake:a')?.state.online).toBe(true);
  });

  it('records per-adapter errors without failing the whole refresh', async () => {
    const registry = new DeviceRegistry();
    registry.register(new FakeAdapter());
    registry.register(new BrokenAdapter());

    const devices = await registry.refresh();
    expect(devices).toHaveLength(2); // fake adapter still enumerated
    expect(registry.errors.broken).toContain('cloud is down');
    expect(registry.errors.fake).toBeUndefined();
  });

  it('throws a clear error for unknown devices', async () => {
    const registry = new DeviceRegistry();
    registry.register(new FakeAdapter());
    await registry.refresh();
    expect(registry.setPower('fake:nope', true)).rejects.toThrow('unknown device');
  });

  it('refreshState pulls live state into the cache', async () => {
    const registry = new DeviceRegistry();
    registry.register(new FakeAdapter());
    await registry.refresh();
    const device = await registry.refreshState('fake:a');
    expect(device.state.brightness).toBe(42);
    expect(device.state.on).toBe(true);
  });
});
