# MQTT edition

This edition publishes Flic Hub and button data through MQTT discovery. It does
not store a Home Assistant token and does not call the Home Assistant REST API.

## What Home Assistant receives

For each hub:

- A registered Flic Hub device.
- A diagnostic connectivity binary sensor.

For each paired button:

- A registered Flic button device linked to its hub through `via_device`.
- `binary_sensor.flic_<address>` for physical down/up state.
- `sensor.flic_<address>_battery` for battery percentage.
- `binary_sensor.flic_<address>_connectivity` for Flic readiness.
- `event.flic_<address>_action` for single, double, and hold actions.
- Home Assistant device triggers for short, double, and long presses.

The button device uses the name assigned in the Flic app. Hardware-based unique
IDs remain stable when a button is renamed. State attributes retain `flic_name`,
`button_address`, `hub_name`, and `hub_serial_number` for dashboards and
templates.

## Requirements

- A Flic Hub with Flic Hub Studio/SDK access enabled.
- At least one paired Flic button.
- An MQTT 3.1.1-compatible broker reachable from the hub.
- Home Assistant's MQTT integration with discovery enabled.
- A dedicated MQTT username and password for each hub.

The bundled client uses plain TCP and effectively QoS 0. It does not support
TLS. Use it only on a trusted or segmented local network; do not expose the
broker port to the internet.

## Installation

1. Configure the MQTT broker and add the MQTT integration to Home Assistant.
2. Create a dedicated broker account for each Flic Hub. Broker configuration
   and ACL guidance are provided below.
3. Open [Flic Hub Studio](https://hubsdk.flic.io/) from the same network.
4. Create a package on the target hub.
5. Replace the generated `main.js` contents with [`main.js`](main.js).
6. Edit the `CONFIG` object at the top of the Hub Studio copy.
7. Save and run the package, then enable restart-after-crash after testing.
8. Confirm `MQTT connected` and the effective state topic in the Studio console.
9. In Home Assistant, open **Settings > Devices & services > MQTT** and confirm
   that the hub and its button devices have appeared.

Hub Studio generates `module.json`; leave it as generated. The bridge logs its
own authoritative version at startup, and no `mqtt.js` companion file is needed.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `HUB_NAME` | Empty | Friendly hub name; blank becomes `Flic Hub <serial>`. |
| `MQTT_HOST` | Placeholder IP | Broker hostname or address without a URL scheme. |
| `MQTT_PORT` | `1883` | Plain TCP broker port. |
| `MQTT_USERNAME` | `flic_hub` | Dedicated broker account. |
| `MQTT_PASSWORD` | Placeholder | Dedicated broker password. |
| `HOME_ASSISTANT_DISCOVERY_PREFIX` | `homeassistant` | Must match HA's MQTT discovery prefix. |
| `MQTT_BASE_TOPIC` | `flic` | Root for hub state and action topics. |
| `HOME_ASSISTANT_STATUS_TOPIC` | `homeassistant/status` | HA birth-status subscription. |
| `EVENT_DEBOUNCE_MS` | `600` | Suppresses duplicate SDK action events. |
| `STATUS_REFRESH_INTERVAL_MS` | `900000` | Refreshes metadata and retained state every 15 minutes. |
| `MQTT_RECONNECT_DELAY_MS` | `5000` | Broker reconnect delay. |
| `MQTT_KEEP_ALIVE_SECONDS` | `60` | MQTT keepalive interval. |
| `LOW_BATTERY_PERCENT` | `8` | Battery alert icon threshold. |
| `LOG_PUBLISHES` | `false` | Logs each successful publish when enabled. |

## Home Assistant Mosquitto add-on example

The official Home Assistant Mosquitto broker add-on supports local users in its
Configuration tab. This example creates one account for other MQTT devices and
one account for each of two Flic Hubs:

```yaml
logins:
  - username: mqtt_other
    password: "CHANGE_ME_OTHER_LONG_RANDOM_PASSWORD"
  - username: flic_hub_kitchen
    password: "CHANGE_ME_KITCHEN_LONG_RANDOM_PASSWORD"
  - username: flic_hub_upstairs
    password: "CHANGE_ME_UPSTAIRS_LONG_RANDOM_PASSWORD"
log_dest: []
log_type: []
customize:
  active: false
  folder: mosquitto
certfile: fullchain.pem
keyfile: privkey.pem
require_certificate: false
```

Replace all three password placeholders with different strong random values.
Do not use the reserved usernames `homeassistant` or `addons`. Save the add-on
configuration and restart the Mosquitto add-on before configuring the hubs.
Home Assistant manages its own internal broker credentials, so they are not
listed under `logins`. Keep the add-on's plain MQTT port `1883` exposed on the
local network because the bundled Flic client does not support TLS.

Set these fields in the existing `CONFIG` object in the Kitchen Hub copy of
`mqtt/main.js`; keep all other fields from the distributed file:

```javascript
HUB_NAME: "Kitchen Hub",
MQTT_HOST: "192.168.1.10",
MQTT_PORT: 1883,
MQTT_USERNAME: "flic_hub_kitchen",
MQTT_PASSWORD: "CHANGE_ME_KITCHEN_LONG_RANDOM_PASSWORD",
```

Set the corresponding fields in the Upstairs Hub copy:

```javascript
HUB_NAME: "Upstairs Hub",
MQTT_HOST: "192.168.1.10",
MQTT_PORT: 1883,
MQTT_USERNAME: "flic_hub_upstairs",
MQTT_PASSWORD: "CHANGE_ME_UPSTAIRS_LONG_RANDOM_PASSWORD",
```

Replace `192.168.1.10` with the Home Assistant or broker address reachable from
both hubs. Both hubs can keep `MQTT_BASE_TOPIC: "flic"`; the module automatically
adds the hardware hub serial to state and discovery topics.

The `mqtt_other` account is intended for existing MQTT devices and services.
Using one shared account for those clients makes initial configuration simpler,
but it also means they share credentials and cannot be revoked separately. Use
individual accounts instead when those devices have different trust levels.

The complete option names and local-login behavior are documented by the
[official Mosquitto add-on](https://github.com/home-assistant/addons/blob/master/mosquitto/DOCS.md).

## Broker permissions and ACLs

The module needs write access to its own `flic/<hub>/#` state tree and
`homeassistant/device/flic_<hub>/#` discovery tree, plus read access to
`homeassistant/status`.

The complete [Mosquitto add-on ACL guide](../docs/mosquitto-addon-acls.md)
contains the required `/share/mosquitto` files, rules for the two example hubs,
restart procedure, authorization tests, current add-on limitation, and rollback.
Do not treat a configured ACL as effective until the forbidden-topic test fails
with an explicit authorization error.

## Availability and restart behavior

Discovery and button states are retained by the broker. Home Assistant can
therefore restore the devices and latest values after its own restart without
waiting for a button press. The module also subscribes to Home Assistant's birth
topic and republishes discovery after HA reports `online`.

The MQTT CONNECT packet includes a retained Last Will. If the hub, module, or
network disappears unexpectedly, the broker publishes `offline` and the button
entities become unavailable. A successful reconnect republishes `online`, all
discovery payloads, and current button data.

## Automations

The easiest method is Home Assistant's automation UI:

1. Create an automation.
2. Add a **Device** trigger.
3. Select the Flic button device.
4. Select short press, double press, or long press.

The MQTT event entity also exposes the most recent event with `event_type`
equal to `single`, `double`, or `hold`.

The REST edition's `flic_click` event and its upstream blueprint are not
available in this edition. Home Assistant restricts arbitrary REST event firing
to administrators; using it would defeat the MQTT edition's reduced-permission
design.

## Dashboard

Use [`../lovelace/flic-card.yaml`](../lovelace/flic-card.yaml) with
the `auto-entities` custom card. Stable entity IDs and identity attributes are
kept compatible with the REST edition, so the visual grouping remains familiar.

## Removal and retained topics

Deleting a button from the Flic Hub causes the module to clear that button's
retained discovery, state, battery, and connectivity messages. Home Assistant
then removes its MQTT entities and device when no references remain.

If the module is permanently removed while the hub is offline, its retained
MQTT messages must be cleared with an MQTT administration tool. Home Assistant
cannot infer that an offline publisher will never return.

## Limitations

- MQTT TLS is not supported by the bundled Flic transport.
- Delivery is QoS 0; local button actions are not durably queued while the
  broker is unavailable.
- The MQTT and REST editions cannot run simultaneously for the same buttons.
- Runtime behavior must be verified on a physical hub and broker.
