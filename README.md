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
- Republishes all states on a configurable interval so they return after a
  Home Assistant restart.
- Identifies the source hub by a configured name and its hardware serial number.
- Removes generated Home Assistant states when a Flic is deleted from the hub.
- Supports HTTP, HTTPS, and optional private or self-signed certificates.
- Keeps the Home Assistant bearer token out of console logs.
- Uses one JavaScript file with all user configuration at the top.
- Includes an optional automatically populated Flic dashboard card.

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
   - Set a different `HUB_NAME` on each hub, such as `Kitchen Hub` and
     `Upstairs Hub`. If left blank, the hub serial number is used automatically.
   - Set `HOME_ASSISTANT_URL` to the Home Assistant URL reachable by the hub.
   - Set `HOME_ASSISTANT_TOKEN` to a long-lived access token created by a
     Home Assistant administrator user.
   - Review the debounce, synchronization, battery, logging, and TLS settings.
5. Save and run the package.
6. Check the Hub Studio console for the startup message or request errors.

Hub Studio automatically creates a `module.json` metadata file, normally with
version `1.0.0`. Leave that file as generated; its version is treated as Studio
package-container metadata rather than the bridge version. `main.js` remains
the only file that must be copied and logs its authoritative bridge version at
startup, for example:

```text
Flic Home Assistant bridge v1.2.0 started as Kitchen Hub for 7 button(s).
```

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
| `HUB_NAME` | Empty | Friendly source-hub name. A blank value becomes `Flic Hub <serial number>`. |
| `HOME_ASSISTANT_URL` | Placeholder | Base URL reachable from the Flic Hub; do not append `/api`. |
| `HOME_ASSISTANT_TOKEN` | Placeholder | Long-lived access token owned by a Home Assistant administrator user. |
| `EVENT_DEBOUNCE_MS` | `600` | Suppresses duplicate events from the same button. |
| `STATUS_SYNC_INTERVAL_MS` | `60000` | Interval for republishing every button, battery, and connectivity state. |
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
  hub_name: Kitchen Hub
  hub_serial_number: "1234567890"
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

Every state and click event also includes `hub_name` and `hub_serial_number`.
The documented Flic Hub SDK exposes the hardware serial number but not the name
assigned to a hub in the Flic app, so `HUB_NAME` is configured separately in
each hub's copy of `main.js`. A blank value falls back to a serial-based name.

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
They exist only in Home Assistant's live state machine, so HA removes them when
it restarts. The Flic module republishes all three states at
`STATUS_SYNC_INTERVAL_MS`; with the default setting, they return within roughly
one minute after Home Assistant is ready. Reducing the interval shortens that
window but increases REST traffic from every configured hub.

## Dashboard card

[`flic-card.yaml`](flic-card.yaml) provides an automatically populated Flic
status card. It uses
[`auto-entities`](https://github.com/thomasloven/lovelace-auto-entities), which
can be installed through HACS.

To install the card:

1. Install `auto-entities` and reload the browser when prompted.
2. Open a Home Assistant dashboard for editing.
3. Add a Manual card.
4. Paste the configuration below. The same configuration is also available as
   the standalone [`flic-card.yaml`](flic-card.yaml) file.

```yaml
type: custom:auto-entities
card:
  type: entities
  title: Flic buttons
  show_header_toggle: false
  state_color: true
card_param: entities
show_empty: false
filter:
  template: |
    {% set batteries = states.sensor
      | selectattr('entity_id', 'match', '^sensor[.]flic_[0-9a-f]{12}_battery$')
      | list %}
    {% set discovered = namespace(hubs=[]) %}
    {% for battery in batteries %}
      {% set serial = battery.attributes.hub_serial_number | default('unknown', true) | string %}
      {% set existing = discovered.hubs
        | selectattr('serial', 'equalto', serial)
        | list %}
      {% if existing | length == 0 %}
        {% set discovered.hubs = discovered.hubs + [{
          'serial': serial,
          'name': battery.attributes.hub_name | default('Unknown Flic Hub', true)
        }] %}
      {% endif %}
    {% endfor %}
    [
    {% for hub in discovered.hubs | sort(attribute='name', case_sensitive=false) %}
      {% if not loop.first %},{% endif %}
      {
        "type": "section",
        "label": {{ ('Hub: ' ~ hub.name) | to_json }}
      }
      {% for battery in batteries | sort(attribute='attributes.flic_name', case_sensitive=false) %}
        {% set battery_serial = battery.attributes.hub_serial_number | default('unknown', true) | string %}
        {% if battery_serial == hub.serial %}
          {% set object_id = battery.object_id.removesuffix('_battery') %}
          {% set label = battery.attributes.flic_name | default(battery.name, true) %}
          ,{
            "type": "section",
            "label": {{ label | to_json }}
          },
          {
            "entity": "binary_sensor.{{ object_id }}",
            "name": "Button",
            "secondary_info": "last-changed"
          },
          {
            "entity": "sensor.{{ object_id }}_battery",
            "name": "Battery"
          },
          {
            "entity": "binary_sensor.{{ object_id }}_connectivity",
            "name": "Connectivity"
          }
        {% endif %}
      {% endfor %}
    {% endfor %}
    ]
```

The card discovers Flic battery sensors automatically and groups them by the
`HUB_NAME` configured on each hub. Within each hub, buttons are sorted by the
name assigned in the Flic app and receive their own section containing button
state, battery level, and connectivity state. Newly added hubs and buttons
appear without editing the card.

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
