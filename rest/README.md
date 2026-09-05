# REST edition

This single-file Flic Hub Studio module forwards button events and status
directly to the Home Assistant REST API. It preserves the original
`flic_click` event contract and requires no MQTT broker.

## Features

- Fires `flic_click` events for single, double, and hold actions.
- Uses the Flic app button name in events and entity attributes.
- Publishes button state, battery level, and connectivity.
- Republishes states every minute by default so they return after an HA restart.
- Adds configured hub name and hardware serial data for multi-hub grouping.
- Removes its three live states when a Flic is deleted.
- Supports HTTP, HTTPS, and optional private/self-signed certificates.

## Requirements

- A Flic Hub with Flic Hub Studio/SDK access enabled.
- At least one paired Flic button.
- Network access from the hub to Home Assistant.
- Home Assistant's `api:` integration.
- A long-lived access token owned by a Home Assistant administrator.

Home Assistant explicitly requires administrator permission for the state-write,
state-delete, and event-fire endpoints used by this bridge. A non-administrator
long-lived token will not work. Prefer the [MQTT edition](../mqtt/README.md) when
storing a broadly privileged Home Assistant token on the hub is unacceptable.

## Installation

1. Open [Flic Hub Studio](https://hubsdk.flic.io/) from the same network.
2. Create a package on the hub.
3. Replace its generated `main.js` with [`main.js`](main.js).
4. Edit the `CONFIG` object at the top of the Hub Studio copy:
   - Give each hub a distinct `HUB_NAME`, or leave it blank for a serial-based name.
   - Set the Home Assistant base URL without `/api` or a trailing slash.
   - Paste an administrator-owned long-lived access token.
   - Review debounce, refresh, logging, and certificate settings.
5. Save and run the package.
6. Check the Hub Studio console for the startup message and request errors.

Hub Studio automatically creates `module.json`, normally with version `1.0.0`.
Leave it as generated. This edition remains a one-file install and logs its own
authoritative bridge version.

> [!IMPORTANT]
> Configure the token only in the Hub Studio copy and never commit it. Treat it
> as an administrator password. A dedicated HA administrator user limits account
> separation but does not reduce the token's broad Home Assistant privileges.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `HUB_NAME` | Empty | Friendly source hub; blank becomes `Flic Hub <serial>`. |
| `HOME_ASSISTANT_URL` | Placeholder | HA base URL reachable from the hub. |
| `HOME_ASSISTANT_TOKEN` | Placeholder | Administrator-owned long-lived token. |
| `EVENT_DEBOUNCE_MS` | `600` | Suppresses duplicate SDK events. |
| `STATUS_SYNC_INTERVAL_MS` | `60000` | Republishes all REST-created states. |
| `LOW_BATTERY_PERCENT` | `8` | Battery alert icon threshold. |
| `LOG_SUCCESSFUL_REQUESTS` | `false` | Enables successful-request logging. |
| `USE_CUSTOM_CERTIFICATE` | `false` | Enables a custom HTTPS trust store. |
| `VERIFY_CERTIFICATE_HOSTNAME` | `true` | Verifies the certificate hostname. |
| `CUSTOM_CERTIFICATES_PEM` | Empty | Trusted PEM certificate(s). |

## Home Assistant interface

Each action fires:

```yaml
event_type: flic_click
event_data:
  button_name: flic_80e4da779fc7
  button_friendly_name: Living Room Button
  button_address: "80:e4:da:77:9f:c7"
  hub_name: Kitchen Hub
  hub_serial_number: "1234567890"
  click_type: single
```

`click_type` is `single`, `double`, or `hold`. Entity IDs are based on the
Bluetooth address and remain stable when the Flic app name changes:

```text
binary_sensor.flic_<address>
sensor.flic_<address>_battery
binary_sensor.flic_<address>_connectivity
```

These are live state-machine representations rather than registered devices.
They disappear when Home Assistant restarts and return at the next configured
state synchronization, normally within one minute.

Example automation:

```yaml
automation:
  - alias: "Flic: Toggle living room lights"
    trigger:
      - platform: event
        event_type: flic_click
        event_data:
          button_name: flic_80e4da779fc7
          click_type: single
    action:
      - service: light.toggle
        target:
          entity_id: light.living_room
```

## Optional blueprint

The upstream Flic Button blueprint offers separate actions for single, double,
and hold events. Its import URL is pinned to the reviewed upstream revision:

[![Open your Home Assistant instance and import the Flic Button blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fblunan%2Fflic-hub-home-assistant-module%2Fblob%2Fb944896861ac88b5263936f390e6873c2ab6d90b%2Fflic-button.yaml)

[Review the pinned blueprint source](https://github.com/blunan/flic-hub-home-assistant-module/blob/b944896861ac88b5263936f390e6873c2ab6d90b/flic-button.yaml).
The blueprint is specific to the REST edition's `flic_click` events.

## Dashboard

Use [`../lovelace/flic-card.yaml`](../lovelace/flic-card.yaml) with
the `auto-entities` custom card.

## Attribution

This edition is derived from Brayan Luna's
[`blunan/flic-hub-home-assistant-module`](https://github.com/blunan/flic-hub-home-assistant-module),
upstream version 1.2.6 at commit
`b944896861ac88b5263936f390e6873c2ab6d90b`. See the repository
[MIT License](../LICENSE).
