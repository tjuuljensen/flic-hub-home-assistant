# Migrating from REST to MQTT

The MQTT edition requests the same state, battery, and connectivity entity IDs
as the REST edition, but ownership changes from temporary REST-created states to
registered MQTT entities. Perform the migration during a quiet period and keep
the REST configuration available for rollback.

## Before switching

1. Install and test an MQTT broker and Home Assistant's MQTT integration.
2. Create a restricted MQTT account for each Flic Hub.
3. Record automations, scripts, dashboards, and templates that listen for the
   `flic_click` event.
4. Back up Home Assistant.
5. Copy and configure [`../mqtt/main.js`](../mqtt/main.js) in a separate Hub
   Studio package, but do not run it yet.

## Switch editions

1. Stop the REST package on the Flic Hub.
2. Restart Home Assistant, or manually remove the old REST-created state
   representations before starting MQTT. A restart is the cleanest boundary
   because those states have no owning integration.
3. Start the configured MQTT package.
4. Confirm that one hub device and the expected child button devices appear
   under the MQTT integration.
5. Confirm the expected entity IDs. Home Assistant appends `_2` when an old or
   conflicting entity already owns a requested ID; resolve such registry
   collisions before changing dashboards.
6. Press each button and verify state, battery, connectivity, and all required
   action types.

Do not run both editions for the same buttons. They would compete for the same
entity IDs while exposing different ownership and automation contracts.

## Update automations

The MQTT edition does not fire the REST edition's global `flic_click` event.
Replace each event trigger with the corresponding MQTT device trigger using
Home Assistant's automation UI:

- `click_type: single` -> short press
- `click_type: double` -> double press
- `click_type: hold` -> long press

The MQTT event entity is also available when an entity-based automation is
preferred. Preserve the existing automation actions; only the trigger needs to
change.

## Dashboard compatibility

The MQTT edition retains the REST entity-ID pattern and identity attributes.
Use [`../lovelace/flic-card.yaml`](../lovelace/flic-card.yaml), which
groups buttons using `hub_name` and `hub_serial_number`.

## Rollback

1. Stop the MQTT package.
2. Start the previous REST package.
3. Restart Home Assistant or wait for the REST edition's configured state-sync
   interval.
4. Restore the previous `flic_click` automation triggers.

MQTT discovery and state messages are retained. If the MQTT edition will not be
used again, clear its `homeassistant/device/flic_<hub>/#` and `flic/<hub>/#`
retained topics with an MQTT administration tool. Merely stopping the package
marks it offline but intentionally does not delete its registered devices.
