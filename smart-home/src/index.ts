import { config } from './config';
import { DeviceRegistry } from './registry';
import { GoveeAdapter } from './adapters/govee';
import { TuyaAdapter } from './adapters/tuya';
import { KasaAdapter } from './adapters/kasa';
import { HueBridge } from './alexa/hueBridge';
import { buildServer } from './server';

const registry = new DeviceRegistry();
registry.register(new GoveeAdapter());
registry.register(new TuyaAdapter());
registry.register(new KasaAdapter());

const enabled = registry.enabledBrands;
console.log(`[hub] adapters enabled: ${enabled.length ? enabled.join(', ') : 'none (set credentials in .env)'}`);

buildServer(registry).listen(config.port, () => {
  console.log(`[hub] control panel: http://localhost:${config.port}`);
});

if (config.alexa.enabled) {
  new HueBridge(registry, config.alexa.port).start();
}

registry
  .refresh()
  .then((devices) => console.log(`[hub] found ${devices.length} device(s)`))
  .catch((err) => console.warn(`[hub] initial refresh failed: ${err.message}`));

setInterval(() => {
  registry.refresh().catch(() => {});
}, config.refreshIntervalMs);
