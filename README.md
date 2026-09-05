# Flic Hub Home Assistant

Flic Hub Studio bridges for publishing paired Flic buttons to Home Assistant.
The repository contains two deliberately separate editions so users install
only the transport and permissions model they prefer.

## Choose an edition

| | MQTT edition | REST edition |
| --- | --- | --- |
| Recommended for | Existing MQTT installations, persistent entities, multi-hub setups | Smallest setup with no MQTT broker |
| Hub installation | One `main.js` | One `main.js` |
| Credential on hub | Dedicated MQTT login; ACL-restricted when supported | Home Assistant administrator token |
| Home Assistant representation | Registered hub/button devices and entities | Temporary state-machine entities |
| Restart behavior | Retained discovery and states restore through MQTT | Hub republishes states periodically |
| Button automations | MQTT device triggers and event entities | `flic_click` event and upstream blueprint |
| Encrypted transport | Not supported by the bundled Hub MQTT client | HTTP or HTTPS, including private CAs |

### MQTT edition - recommended when MQTT is available

[`mqtt/main.js`](mqtt/main.js) registers the hub and buttons through Home
Assistant MQTT discovery. It provides native devices, retained state, battery,
connectivity, action event entities, and device triggers without requiring a
Home Assistant token.

See [MQTT installation and configuration](mqtt/README.md).

### REST edition - simplest direct bridge

[`rest/main.js`](rest/main.js) connects directly to Home Assistant's REST API.
It remains compact and compatible with existing `flic_click` automations, but
Home Assistant requires the long-lived token owner to be an administrator.

See [REST installation and configuration](rest/README.md).

## Repository layout

```text
.
|-- mqtt/
|   |-- main.js            # Single-file MQTT Hub Studio module
|   `-- README.md           # MQTT setup and automation guidance
|-- rest/
|   |-- main.js            # Single-file REST Hub Studio module
|   `-- README.md           # REST setup and event contract
|-- lovelace/
|   `-- flic-card.yaml      # Shared auto-entities dashboard card
|-- docs/
|   |-- migrating-rest-to-mqtt.md
|   `-- mosquitto-addon-acls.md
|-- LICENSE
`-- README.md
```

The `module.json` file is intentionally absent. Flic Hub Studio creates it
automatically. For either edition, create a Hub Studio package and copy only
the selected `main.js` into the generated file.

## Migration

REST and MQTT must not run for the same buttons at the same time because both
editions request the same state, battery, and connectivity entity IDs. Follow
the [REST-to-MQTT migration guide](docs/migrating-rest-to-mqtt.md), including
the required automation changes.

## Lovelace card

Both editions keep the same state, battery, and connectivity entity-ID pattern
and identity attributes. The same `auto-entities` card therefore discovers all
Flic sensors and groups them by configured hub and Flic app button name.

Install [`auto-entities`](https://github.com/thomasloven/lovelace-auto-entities),
add a Manual card, and paste:

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

The maintained standalone copy is [`lovelace/flic-card.yaml`](lovelace/flic-card.yaml).

## Alternative projects

[`JohNan/home-assistant-flichub`](https://github.com/JohNan/home-assistant-flichub)
is a fuller HACS custom integration with native devices, additional diagnostics,
Flic Duo/Twist features, virtual devices, and infrared support. It also requires
a companion TCP server on the hub, listening on port 8124 by default; keep that
service on a trusted network.

[`alexander-cato/flic-mqtt-homeassistant`](https://github.com/alexander-cato/flic-mqtt-homeassistant)
is another MQTT bridge. This repository's MQTT edition differs by preserving
the REST entity-ID/attribute contract, bundling installation into one file,
handling Home Assistant birth and MQTT Last Will, cleaning deleted discovery,
and documenting multi-hub ACL separation and migration.

## Development and validation

Check both modules without executing their Flic-specific imports:

```shell
node --check rest/main.js
node --check mqtt/main.js
```

Discovery, broker reconnection, and physical button events require a Flic Hub,
an MQTT broker, and Home Assistant, so they cannot be fully verified statically.

## Attribution and license

The REST edition is derived from Brayan Luna's
[`blunan/flic-hub-home-assistant-module`](https://github.com/blunan/flic-hub-home-assistant-module).
The bundled MQTT transport is adapted from
[`50ButtonsEach/flic-hub-sdk-mqtt-js`](https://github.com/50ButtonsEach/flic-hub-sdk-mqtt-js),
originally copyright Gordon Williams, Pur3 Ltd and modified by Flic Shortcut
Labs.

Copyright and permission notices are retained in the applicable standalone
files and in the repository [MIT License](LICENSE).
