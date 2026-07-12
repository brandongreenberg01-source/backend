# Smart Home Hub

One control panel (and one Alexa integration) for smart devices from **different brands**. Runs on any machine on your home network — a laptop, a Raspberry Pi, an old desktop.

```
                        ┌──────────────────────────────┐
  "Alexa, turn off      │        Smart Home Hub        │      cloud APIs
   the desk lamp"  ───▶ │                              │ ───▶ Govee
                        │  ┌────────┐   ┌───────────┐  │ ───▶ Tuya / Smart Life
  Echo discovers the    │  │Emulated│   │  Device   │  │
  hub as a local        │  │  Hue   │──▶│ Registry  │  │      local network
  Philips Hue bridge    │  │ bridge │   │ +adapters │  │ ───▶ TP-Link Kasa (TCP 9999)
                        │  └────────┘   └───────────┘  │
  Browser control ────▶ │  web panel     network scan  │ ───▶ SSDP / mDNS / Kasa UDP
  panel (GUI)           └──────────────────────────────┘      (find EVERYTHING)
```

## What's inside

| Piece | What it does |
|---|---|
| **Adapters** | Govee (cloud API), Tuya/Smart Life (cloud API), TP-Link Kasa (pure local — no account needed). All behind one `Adapter` interface, so new brands are one file each. |
| **Network scanner** | Sweeps your LAN via Kasa UDP broadcast + SSDP/UPnP + mDNS/Bonjour and lists **every** responding device — including ones the hub can't control yet, so you can find out "what all there is". |
| **Alexa voice control** | The hub emulates a Philips Hue bridge on your LAN. Echo devices discover local Hue bridges natively, so there is **no skill to install and no AWS account** — every hub device shows up as an Alexa device. |
| **Web control panel** | Device tiles with on/off, brightness slider, and a color picker, served at `http://<hub>:3000`. |

## Quick start

```bash
cd smart-home
bun install
cp .env.example .env      # then fill in the credentials you have (see below)
sudo bun start            # sudo only needed for the Alexa bridge on port 80
```

Open `http://localhost:3000`, hit **Scan network**, and see what's on your LAN.

> No bun? `npm install -g bun` (or use `npx bun`). Everything is plain TypeScript with a single runtime dependency (express).

### Credentials

- **TP-Link Kasa** — nothing needed. Devices are found by local broadcast and controlled directly over TCP.
- **Govee** — free API key: Govee Home app → profile tab → ⚙ **Settings** → **Apply for API Key** (arrives by email, usually within minutes). Put it in `GOVEE_API_KEY`.
- **Tuya / Smart Life** — free developer project at [iot.tuya.com](https://iot.tuya.com):
  1. **Cloud → Create Cloud Project** (pick the data center matching your Smart Life account region, and subscribe to the free *IoT Core* + *Authorization* services).
  2. In the project: **Devices → Link Tuya App Account** → scan the QR code with the Smart Life app. All your app devices appear in the project.
  3. Copy the project's **Access ID → `TUYA_CLIENT_ID`** and **Access Secret → `TUYA_CLIENT_SECRET`**, set `TUYA_REGION` (`us`/`eu`/`cn`/`in`).

Adapters with missing credentials are simply skipped — the panel tells you which ones are active.

## Alexa setup

1. Start the hub with the bridge on port 80 (`ALEXA_HUE_PORT=80`, the default). Port 80 needs privileges:
   `sudo bun start` — or once: `sudo setcap 'cap_net_bind_service=+ep' $(which bun)` then plain `bun start`.
   *(Echo gen 1/2 also accept other ports; gen 3+ requires 80.)*
2. Make sure the hub machine and your Echo are on the **same network/VLAN**.
3. Say **"Alexa, discover devices"** (or Alexa app → Devices → + → Add Device → Light → Philips Hue).
4. Every hub device appears in Alexa by its name: *"Alexa, turn off Desk Lamp"*, *"Alexa, set Bedroom Strip to 30%"*, *"Alexa, make the Couch Light blue"*.

New devices added later? Refresh in the panel, then "Alexa, discover devices" again.

## HTTP API

| Route | What |
|---|---|
| `GET /api/devices` | All known devices with cached state |
| `POST /api/devices/refresh` | Re-enumerate every adapter |
| `GET /api/devices/:id/state` | Live state for one device |
| `POST /api/devices/:id/power` | `{"on": true}` |
| `POST /api/devices/:id/brightness` | `{"value": 0-100}` |
| `POST /api/devices/:id/color` | `{"r":255,"g":0,"b":128}` |
| `POST /api/scan` | Full network sweep (Kasa + SSDP + mDNS) |
| `GET /api/health` | Enabled adapters + last per-adapter errors |

Device ids are `brand:nativeId`, e.g. `kasa:8006...`, `govee:AA:BB:...`, `tuya:bf123...`.

## Adding another brand

Implement the `Adapter` interface (`src/types.ts`) in one file under `src/adapters/`, register it in `src/index.ts`. Good next candidates: Philips Hue (local bridge REST), LIFX (local UDP), Wemo (UPnP). The scan results' `hints` column usually tells you what protocol an unknown device speaks.

## Tests

```bash
bun test
```

Covers the Kasa wire cipher, Tuya request signing, color conversions, the mDNS packet parser, and registry behavior (merging, offline marking, per-adapter error isolation).

## Notes & limits

- The hub must run **inside your home network** for Kasa control, network scanning, and Alexa discovery. Govee/Tuya control works from anywhere (cloud APIs).
- Govee's free API tier allows 10,000 requests/day — plenty for a household.
- The emulated bridge speaks Hue API v1 (what Alexa's local discovery uses). Non-Alexa Hue apps may not pair with it.
- State shown in the panel is optimistic after a command and re-synced on the next refresh cycle.
