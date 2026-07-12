export type DeviceType = 'light' | 'plug' | 'switch' | 'unknown';

export type Capability = 'power' | 'brightness' | 'color';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface DeviceState {
  online: boolean;
  on?: boolean;
  /** 0-100 */
  brightness?: number;
  color?: RGB;
}

export interface Device {
  /** Globally unique: `${brand}:${nativeId}` */
  id: string;
  nativeId: string;
  name: string;
  brand: string;
  type: DeviceType;
  model?: string;
  ip?: string;
  capabilities: Capability[];
  state: DeviceState;
}

export interface Adapter {
  readonly brand: string;
  /** True when required credentials/config are present. */
  enabled(): boolean;
  /** Enumerate devices (cloud list or local scan). */
  listDevices(): Promise<Device[]>;
  /** Fetch live state for one device. */
  getState(device: Device): Promise<DeviceState>;
  setPower(device: Device, on: boolean): Promise<void>;
  setBrightness?(device: Device, percent: number): Promise<void>;
  setColor?(device: Device, rgb: RGB): Promise<void>;
}

export interface DiscoveredDevice {
  ip: string;
  sources: string[];
  name?: string;
  hints: Record<string, string>;
  /** Set when the discovered host maps to a device we already control. */
  managedId?: string;
}
