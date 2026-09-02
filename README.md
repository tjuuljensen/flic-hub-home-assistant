# Flic Hub Home Assistant

A single-file Flic Hub Studio module that forwards Flic button events and
status to Home Assistant through its REST API.

This project combines the multi-file
[`blunan/flic-hub-home-assistant-module`](https://github.com/blunan/flic-hub-home-assistant-module)
implementation into one documented `main.js` file. It preserves the upstream
Home Assistant event and entity naming contract while making Hub Studio setup
and configuration easier.

## Features

- Fires `flic_click` events for single, double, and hold actions.
- Includes the user-assigned Flic app name in events and entity attributes.
- Publishes button state, battery level, and connectivity to Home Assistant.
- Refreshes battery and connectivity states on a configurable interval.
- Removes generated Home Assistant states when a Flic is deleted from the hub.
- Supports HTTP, HTTPS, and optional private or self-signed certificates.
- Keeps the Home Assistant bearer token out of console logs.
- Uses one JavaScript file with all user configuration at the top.

## Requirements

- A Flic Hub with Flic Hub Studio/SDK access enabled.
- A Flic button paired with the hub.
- Network access from the Flic Hub to Home Assistant.
- The Home Assistant `api:` integration.
- A Home Assistant long-lived access token owned by an administrator user.

## Installation

1. Open [Flic Hub Studio](https://hubsdk.flic.io/) from a computer on the same
   network as the Flic Hub.
2. Create a package on the hub.
3. Replace the package's `main.js` contents with [`main.js`](main.js).
4. Edit the `CONFIG` object at the top of the Hub Studio copy:
   - Set `HOME_ASSISTANT_URL` to the Home Assistant URL reachable by the hub.
   - Set `HOME_ASSISTANT_TOKEN` to a long-lived access token created by a
     Home Assistant administrator user.
   - Review the debounce, synchronization, battery, logging, and TLS settings.
5. Save and run the package.
6. Check the Hub Studio console for the startup message or request errors.

Some older Hub Studio versions may retain a generated `module.json` metadata
file. That is fine; `main.js` is the only project code file that must be copied.

> [!IMPORTANT]
> Configure the token in the copy stored in Hub Studio (never commit to repo).
> Treat the token like a password.
> The REST endpoints used to create/delete states and fire events require an
> administrator token. Prefer a dedicated administrator user for the Flic
> bridge instead of using the Home Assistant owner account. The token still
> has broad administrator access and must be protected accordingly.

## Optional Home Assistant blueprint

The module works with normal Home Assistant automations and does not require a
blueprint. As an optional convenience, the upstream Flic Button blueprint
provides separate actions for single, double, and hold events.

[![Open your Home Assistant instance and import the Flic Button blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fblunan%2Fflic-hub-home-assistant-module%2Fblob%2Fb944896861ac88b5263936f390e6873c2ab6d90b%2Fflic-button.yaml)

The import is pinned to the reviewed upstream revision so later upstream
changes cannot silently alter the blueprint. You can also
[review the blueprint source](https://github.com/blunan/flic-hub-home-assistant-module/blob/b944896861ac88b5263936f390e6873c2ab6d90b/flic-button.yaml)
before importing it.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOME_ASSISTANT_URL` | Placeholder | Base URL reachable from the Flic Hub; do not append `/api`. |
| `HOME_ASSISTANT_TOKEN` | Placeholder | Long-lived access token owned by a Home Assistant administrator user. |
| `EVENT_DEBOUNCE_MS` | `600` | Suppresses duplicate events from the same button. |
| `STATUS_SYNC_INTERVAL_MS` | `60000` | Battery and connectivity refresh interval. |
| `LOW_BATTERY_PERCENT` | `8` | Threshold for the battery alert icon. |
| `LOG_SUCCESSFUL_REQUESTS` | `false` | Enables concise success logging. Errors are always logged. |
| `USE_CUSTOM_CERTIFICATE` | `false` | Enables the Flic SDK custom trust store. |
| `VERIFY_CERTIFICATE_HOSTNAME` | `true` | Validates the URL hostname against the certificate. |
| `CUSTOM_CERTIFICATES_PEM` | Empty | One or more trusted certificates in PEM format. |

The 600 ms debounce retains the upstream workaround for hubs that emit an
extra event after a hold. Reducing it can improve rapid consecutive actions but
may allow duplicate actions on affected hub firmware.

## Home Assistant interface

Each click fires this event:

```yaml
event_type: flic_click
event_data:
  button_name: flic_80e4da779fc7
  button_friendly_name: Living Room Button
  button_address: "80:e4:da:77:9f:c7"
  click_type: single
```

`click_type` is `single`, `double`, or `hold`.

### Button names and stable IDs

`button_name` and the generated entity IDs remain based on the Bluetooth
address. This makes them unique and prevents a Flic app rename from breaking
automations or creating replacement entities.

`button_friendly_name` contains the user-assigned name from the Flic app. The
same value is used for each entity's Home Assistant `friendly_name` and is also
available in the `flic_name` state attribute. The original Bluetooth address is
available in the `button_address` state attribute.

Renaming a button in the Flic app causes the module to refresh its button,
battery, and connectivity states when the Flic SDK emits `buttonUpdated`. The
stable entity IDs and `button_name` event value do not change.

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

The module also creates these state representations through the Home Assistant
REST API:

```text
binary_sensor.flic_<address>
sensor.flic_<address>_battery
binary_sensor.flic_<address>_connectivity
```

These REST-created states are not a native Home Assistant integration and do
not register the buttons as devices in the Home Assistant device registry.

## Alternative projects

For a fuller native Home Assistant experience, consider
[`JohNan/home-assistant-flichub`](https://github.com/JohNan/home-assistant-flichub).
It is a HACS custom integration that registers the Flic Hub and its buttons as
Home Assistant devices and provides UI device triggers, additional diagnostics,
Flic Duo and Twist features, virtual light/cover/speaker entities, and infrared
support.

That integration requires both a Home Assistant custom component and its
companion
[`pyflichub-tcpclient`](https://github.com/JohNan/pyflichub-tcpclient)
server on the Flic Hub. The companion listens on TCP port 8124 by default and
should only be exposed on a trusted network. It uses the `flichub_click` event
contract, so it is not a drop-in replacement for automations using this
project's `flic_click` events.

Choose this project when a small, outbound REST bridge and the least possible
Home Assistant setup are more important than native device registration and
the additional Flic features.

## Development and validation

Check JavaScript syntax with Node.js without executing the Flic-specific
modules:

```shell
node --check main.js
```

The Flic SDK supplies the `buttons` and `http` modules at runtime, so complete
behavior must be verified on a physical Flic Hub.

## Attribution and license

This project is derived from Brayan Luna's
[`flic-hub-home-assistant-module`](https://github.com/blunan/flic-hub-home-assistant-module),
version 1.2.6. The original copyright notice is retained.

The combined version and subsequent modifications are copyright 2026 Torsten
Juul-Jensen. The project is distributed under the [MIT License](LICENSE).
