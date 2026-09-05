/*
 * Flic Hub to Home Assistant - single-file MQTT edition
 *
 * Purpose:
 *   Publish Flic buttons to Home Assistant through MQTT discovery without
 *   storing a Home Assistant administrator token on the Flic Hub.
 *
 * Behavior:
 *   - Registers the hub and each paired Flic as Home Assistant MQTT devices.
 *   - Creates button-state, battery, connectivity, and event entities.
 *   - Creates device automation triggers for single, double, and hold actions.
 *   - Preserves the REST edition's entity IDs where Home Assistant can do so.
 *   - Uses retained discovery/state messages and republishes after HA startup.
 *   - Uses the configured hub name and SDK hub serial for multi-hub grouping.
 *   - Removes retained discovery and state topics when a Flic is deleted.
 *   - Sends a retained MQTT Last Will so entities become unavailable if the
 *     hub or this module unexpectedly disconnects.
 *
 * Usage:
 *   1. Configure an MQTT broker and Home Assistant's MQTT integration.
 *   2. Create a restricted MQTT account for this Flic Hub.
 *   3. In Flic Hub Studio, create a package and replace main.js with this file.
 *      Hub Studio creates module.json automatically; no other file is needed.
 *   4. Edit only USER CONFIGURATION below, save, and run the package.
 *
 * Inputs:
 *   Paired Flic buttons, hub metadata, and the CONFIG values below.
 *
 * Outputs and side effects:
 *   Publishes MQTT discovery, state, availability, and button-action messages.
 *   MQTT credentials are intentionally never written to the console.
 *
 * Prerequisites:
 *   Flic Hub Studio/SDK access, a reachable MQTT 3.1.1 broker, and Home
 *   Assistant with MQTT discovery enabled. This client uses plain TCP only.
 *
 * Version: 2.0.0-mqtt.1
 * Changelog:
 *   2.0.0-mqtt.1 - Initial single-file MQTT edition with discovery, native
 *                  devices, retained state, HA birth handling, and Last Will.
 *
 * MQTT transport adapted from:
 *   https://github.com/50ButtonsEach/flic-hub-sdk-mqtt-js
 * Full MIT notices are retained at the end of this standalone file.
 */

// -----------------------------------------------------------------------------
// USER CONFIGURATION - edit these values in the copy stored on the Flic Hub.
// Keep the repository copy free of real credentials.
// -----------------------------------------------------------------------------

const CONFIG = {
  // The Flic SDK exposes the hub serial but not its Flic-app name. Give each
  // hub a distinct name, for example "Kitchen Hub" or "Upstairs Hub".
  // Leave blank to use "Flic Hub <serial number>" automatically.
  HUB_NAME: "",

  // MQTT broker hostname or IP address only - do not include mqtt:// or a path.
  // The bundled Flic MQTT client supports unencrypted TCP, normally port 1883.
  MQTT_HOST: "192.168.1.10",
  MQTT_PORT: 1883,

  // Use a dedicated broker account. Restrict it to this hub's Flic state and
  // discovery topics when the broker reliably enforces ACLs; see mqtt/README.md.
  MQTT_USERNAME: "flic_hub",
  MQTT_PASSWORD: "PASTE_MQTT_PASSWORD_HERE",

  // Home Assistant's default discovery prefix is "homeassistant". Change this
  // only if the MQTT integration uses a custom discovery prefix.
  HOME_ASSISTANT_DISCOVERY_PREFIX: "homeassistant",

  // State topics are published below <base>/<hub serial>/...
  MQTT_BASE_TOPIC: "flic",

  // Home Assistant publishes its birth status here by default. The module
  // listens for "online" and republishes discovery and current state.
  HOME_ASSISTANT_STATUS_TOPIC: "homeassistant/status",

  // Retains the original duplicate-event workaround for affected hub firmware.
  // Set to 0 only when rapid clicks matter and your hub emits no duplicates.
  EVENT_DEBOUNCE_MS: 600,

  // Periodically refresh metadata, battery, and connectivity. Retained MQTT
  // data handles HA restarts, so this can be much longer than the REST edition.
  STATUS_REFRESH_INTERVAL_MS: 15 * 60 * 1000,

  // Delay before reconnecting after a broker/network failure.
  MQTT_RECONNECT_DELAY_MS: 5 * 1000,
  MQTT_KEEP_ALIVE_SECONDS: 60,

  // Battery percentages at or below this value use the alert icon.
  LOW_BATTERY_PERCENT: 8,

  // Successful publishes are normally noise. Errors and lifecycle events are
  // always logged. Credentials are never logged.
  LOG_PUBLISHES: false
};

// -----------------------------------------------------------------------------
// FLIC/HOME ASSISTANT BRIDGE - normally no changes are needed below this line.
// -----------------------------------------------------------------------------

const buttonManager = require("buttons");
const hubInfo = require("hubinfo");

const MODULE_VERSION = "2.0.0-mqtt.1";
const CLICK_SINGLE = "single";
const CLICK_DOUBLE = "double";
const CLICK_HOLD = "hold";
const STATE_ON = "ON";
const STATE_OFF = "OFF";
const STATE_UNKNOWN = "unknown";

const lastEventTimestampByButton = {};
const buttonStateByButton = {};
const knownButtonsByAddress = {};
const pendingRemovalKeys = {};

let mqttClient;
let reconnectTimer = null;
let homeAssistantBirthTimer = null;
let hubName;
let hubSerial;
let hubKey;
let discoveryNode;
let hubBaseTopic;
let hubAvailabilityTopic;

function start() {
  validateConfiguration();

  hubSerial = String(hubInfo.serialNumber || "unknown");
  hubKey = sanitizeTopicPart(hubSerial, "unknown");
  discoveryNode = "flic_" + hubKey;
  hubName = String(CONFIG.HUB_NAME || "").trim() || "Flic Hub " + hubSerial;
  hubBaseTopic = trimTopic(CONFIG.MQTT_BASE_TOPIC) + "/" + hubKey;
  hubAvailabilityTopic = hubBaseTopic + "/availability";

  registerButtonListeners();
  connectMqtt();
  setInterval(refreshAllButtons, CONFIG.STATUS_REFRESH_INTERVAL_MS);

  console.log(
    "Flic Home Assistant MQTT bridge v" + MODULE_VERSION + " starting as " +
    hubName + "; state topic " + hubBaseTopic + "."
  );
}

function validateConfiguration() {
  const errors = [];
  const host = String(CONFIG.MQTT_HOST || "").trim();
  const username = String(CONFIG.MQTT_USERNAME || "").trim();
  const password = String(CONFIG.MQTT_PASSWORD || "");

  if (typeof CONFIG.HUB_NAME !== "string") {
    errors.push("HUB_NAME must be a string (it may be blank).");
  }
  if (!host || /:\/\//.test(host) || /[\/\\]/.test(host)) {
    errors.push("MQTT_HOST must be a hostname or IP address without a scheme or path.");
  }
  if (!Number.isInteger(CONFIG.MQTT_PORT) || CONFIG.MQTT_PORT < 1 || CONFIG.MQTT_PORT > 65535) {
    errors.push("MQTT_PORT must be an integer from 1 to 65535.");
  }
  if (!username) {
    errors.push("MQTT_USERNAME must identify a dedicated broker account.");
  }
  if (!password || password === "PASTE_MQTT_PASSWORD_HERE") {
    errors.push("MQTT_PASSWORD still contains the placeholder value.");
  }
  validateTopicSetting(errors, "HOME_ASSISTANT_DISCOVERY_PREFIX", CONFIG.HOME_ASSISTANT_DISCOVERY_PREFIX);
  validateTopicSetting(errors, "MQTT_BASE_TOPIC", CONFIG.MQTT_BASE_TOPIC);
  validateTopicSetting(errors, "HOME_ASSISTANT_STATUS_TOPIC", CONFIG.HOME_ASSISTANT_STATUS_TOPIC);
  if (!isNonNegativeNumber(CONFIG.EVENT_DEBOUNCE_MS)) {
    errors.push("EVENT_DEBOUNCE_MS must be zero or a positive number.");
  }
  if (!isPositiveNumber(CONFIG.STATUS_REFRESH_INTERVAL_MS)) {
    errors.push("STATUS_REFRESH_INTERVAL_MS must be a positive number.");
  }
  if (!isPositiveNumber(CONFIG.MQTT_RECONNECT_DELAY_MS)) {
    errors.push("MQTT_RECONNECT_DELAY_MS must be a positive number.");
  }
  if (!isPositiveNumber(CONFIG.MQTT_KEEP_ALIVE_SECONDS)) {
    errors.push("MQTT_KEEP_ALIVE_SECONDS must be a positive number.");
  }
  if (!isNonNegativeNumber(CONFIG.LOW_BATTERY_PERCENT) || CONFIG.LOW_BATTERY_PERCENT > 100) {
    errors.push("LOW_BATTERY_PERCENT must be between 0 and 100.");
  }

  if (errors.length > 0) {
    for (let index = 0; index < errors.length; index += 1) {
      console.log("Configuration error: " + errors[index]);
    }
    throw new Error("Flic Home Assistant MQTT configuration is invalid.");
  }
}

function validateTopicSetting(errors, name, value) {
  const topic = String(value || "").trim();
  if (!topic || topic[0] === "/" || topic[topic.length - 1] === "/" || /[+#]/.test(topic)) {
    errors.push(name + " must be a non-empty topic without edge slashes or wildcards.");
  }
}

function isPositiveNumber(value) {
  return typeof value === "number" && isFinite(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && isFinite(value) && value >= 0;
}

function connectMqtt() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  mqttClient = createMqttClient(String(CONFIG.MQTT_HOST).trim(), {
    port: CONFIG.MQTT_PORT,
    clientId: "flic-ha-" + hubKey,
    keepAlive: CONFIG.MQTT_KEEP_ALIVE_SECONDS,
    username: CONFIG.MQTT_USERNAME,
    password: CONFIG.MQTT_PASSWORD,
    will: {
      topic: hubAvailabilityTopic,
      message: "offline",
      retain: true
    }
  });

  mqttClient.on("connected", onMqttConnected);
  mqttClient.on("message", onMqttMessage);
  mqttClient.on("disconnected", function () {
    console.log("MQTT disconnected; retrying in " + CONFIG.MQTT_RECONNECT_DELAY_MS + " ms.");
    scheduleReconnect();
  });
  mqttClient.on("error", function (message) {
    console.log("MQTT error: " + String(message));
    scheduleReconnect();
  });
  mqttClient.connect();
}

function scheduleReconnect() {
  if (reconnectTimer !== null) {
    return;
  }
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    if (mqttClient) {
      mqttClient.disconnect();
    }
    connectMqtt();
  }, CONFIG.MQTT_RECONNECT_DELAY_MS);
}

function onMqttConnected() {
  console.log("MQTT connected to " + CONFIG.MQTT_HOST + ":" + CONFIG.MQTT_PORT + ".");
  mqttClient.subscribe(CONFIG.HOME_ASSISTANT_STATUS_TOPIC);
  publish(hubAvailabilityTopic, "online", true);
  flushPendingRemovals();
  publishAllDiscoveryAndStates();
}

function onMqttMessage(topic, message) {
  if (
    String(topic) === CONFIG.HOME_ASSISTANT_STATUS_TOPIC &&
    String(message).trim().toLowerCase() === "online"
  ) {
    // Retained discovery normally makes entities return automatically. This
    // birth response also repairs entities after an MQTT integration reload.
    if (homeAssistantBirthTimer !== null) {
      clearTimeout(homeAssistantBirthTimer);
    }
    homeAssistantBirthTimer = setTimeout(function () {
      homeAssistantBirthTimer = null;
      console.log("Home Assistant MQTT birth detected; republishing Flic discovery.");
      publishAllDiscoveryAndStates();
    }, 1000 + Math.floor(Math.random() * 2000));
  }
}

function registerButtonListeners() {
  buttonManager.on("buttonAdded", function (event) {
    withButton(event.button || event.bdaddr, "buttonAdded", registerAndPublishButton);
  });

  buttonManager.on("buttonConnected", function (event) {
    withButton(event.bdaddr, "buttonConnected", registerAndPublishButton);
  });

  buttonManager.on("buttonReady", function (event) {
    withButton(event.bdaddr, "buttonReady", function (button) {
      rememberButton(button);
      publishButtonConnectivity(button);
    });
  });

  buttonManager.on("buttonDisconnected", function (event) {
    withButton(event.bdaddr, "buttonDisconnected", function (button) {
      rememberButton(button);
      publishButtonConnectivity(button);
    });
  });

  // Renames and metadata changes update the existing registry entry because
  // unique IDs are based on hardware identity, not the friendly Flic name.
  buttonManager.on("buttonUpdated", function (event) {
    withButton(event.button || event.bdaddr, "buttonUpdated", registerAndPublishButton);
  });

  buttonManager.on("buttonDeleted", removeButton);

  buttonManager.on("buttonDown", function (event) {
    withButton(event.bdaddr, "buttonDown", function (button) {
      buttonStateByButton[getButtonKey(button)] = STATE_ON;
      publishButtonState(button);
    });
  });

  buttonManager.on("buttonUp", function (event) {
    withButton(event.bdaddr, "buttonUp", function (button) {
      buttonStateByButton[getButtonKey(button)] = STATE_OFF;
      publishButtonState(button);
    });
  });

  buttonManager.on("buttonSingleOrDoubleClickOrHold", function (event) {
    const button = getButton(event.bdaddr, "button click");
    if (button === null) {
      return;
    }

    const buttonKey = getButtonKey(button);
    const timestamp = Date.now();
    const previousTimestamp = lastEventTimestampByButton[buttonKey] || 0;
    if (timestamp - previousTimestamp < CONFIG.EVENT_DEBOUNCE_MS) {
      console.log(
        "Ignored duplicate event for " + getButtonFriendlyName(button) +
        "; previous event was " + (timestamp - previousTimestamp) + " ms earlier."
      );
      return;
    }

    lastEventTimestampByButton[buttonKey] = timestamp;
    rememberButton(button);
    const clickType = event.isSingleClick
      ? CLICK_SINGLE
      : event.isDoubleClick
        ? CLICK_DOUBLE
        : CLICK_HOLD;
    publishButtonAction(button, clickType);
    publishButtonBattery(button);
  });
}

function withButton(reference, context, callback) {
  let button = reference;
  if (typeof reference === "string") {
    button = getButton(reference, context);
  }
  if (button) {
    callback(button);
  }
}

function getButton(address, context) {
  const button = buttonManager.getButton(address);
  if (button === null) {
    console.log("Ignored " + context + " for unknown Flic address " + String(address) + ".");
  }
  return button;
}

function publishAllDiscoveryAndStates() {
  publishHubDiscovery();
  publish(hubAvailabilityTopic, "online", true);

  const buttons = buttonManager.getButtons();
  for (let index = 0; index < buttons.length; index += 1) {
    registerAndPublishButton(buttons[index]);
  }
}

function refreshAllButtons() {
  if (!mqttClient || !mqttClient.isConnected()) {
    return;
  }
  const buttons = buttonManager.getButtons();
  for (let index = 0; index < buttons.length; index += 1) {
    registerAndPublishButton(buttons[index]);
  }
}

function publishHubDiscovery() {
  const topic = discoveryTopic("hub");
  const payload = {
    device: {
      identifiers: [getHubDeviceIdentifier()],
      name: hubName,
      manufacturer: "Flic",
      model: "Flic Hub",
      serial_number: hubSerial,
      sw_version: hubInfo.firmwareVersion == null ? undefined : String(hubInfo.firmwareVersion),
      configuration_url: "https://hubsdk.flic.io/"
    },
    origin: getOrigin(),
    components: {
      connectivity: {
        platform: "binary_sensor",
        name: "Connectivity",
        unique_id: getHubDeviceIdentifier() + "_connectivity",
        default_entity_id: "binary_sensor.flic_hub_" + hubKey + "_connectivity",
        device_class: "connectivity",
        state_topic: hubAvailabilityTopic,
        payload_on: "online",
        payload_off: "offline",
        entity_category: "diagnostic"
      }
    }
  };
  publishJson(topic, payload, true);
}

function registerAndPublishButton(button) {
  const buttonKey = getButtonKey(button);
  rememberButton(button);
  if (!Object.prototype.hasOwnProperty.call(buttonStateByButton, buttonKey)) {
    buttonStateByButton[buttonKey] = STATE_OFF;
  }
  if (!Object.prototype.hasOwnProperty.call(lastEventTimestampByButton, buttonKey)) {
    lastEventTimestampByButton[buttonKey] = Date.now() - CONFIG.EVENT_DEBOUNCE_MS;
  }

  publishButtonDiscovery(button);
  publishButtonState(button);
  publishButtonBattery(button);
  publishButtonConnectivity(button);
}

function publishButtonDiscovery(button) {
  const buttonKey = getButtonKey(button);
  const topics = getButtonTopics(buttonKey);
  const entityBase = "flic_" + buttonKey;
  const uniqueBase = "flic_" + buttonKey;
  const deviceIdentifier = getButtonDeviceIdentifier(button);
  const device = {
    identifiers: [deviceIdentifier],
    name: getButtonFriendlyName(button),
    manufacturer: "Flic",
    model: getButtonModel(button),
    serial_number: button.serialNumber == null ? undefined : String(button.serialNumber),
    hw_version: button.flicVersion == null ? undefined : "Flic " + String(button.flicVersion),
    sw_version: button.firmwareVersion == null ? undefined : String(button.firmwareVersion),
    connections: button.bdaddr ? [["bluetooth", String(button.bdaddr)]] : undefined,
    via_device: getHubDeviceIdentifier()
  };
  const commonAvailability = {
    availability_topic: hubAvailabilityTopic,
    payload_available: "online",
    payload_not_available: "offline"
  };

  const payload = {
    device: device,
    origin: getOrigin(),
    components: {
      button_state: Object.assign({
        platform: "binary_sensor",
        name: "Button",
        unique_id: uniqueBase,
        default_entity_id: "binary_sensor." + entityBase,
        state_topic: topics.state,
        value_template: "{{ value_json.state }}",
        json_attributes_topic: topics.state,
        payload_on: STATE_ON,
        payload_off: STATE_OFF,
        icon: "mdi:gesture-tap-button"
      }, commonAvailability),
      battery: Object.assign({
        platform: "sensor",
        name: "Battery",
        unique_id: uniqueBase + "_battery",
        default_entity_id: "sensor." + entityBase + "_battery",
        state_topic: topics.battery,
        value_template: "{{ value_json.state }}",
        json_attributes_topic: topics.battery,
        device_class: "battery",
        unit_of_measurement: "%",
        state_class: "measurement",
        entity_category: "diagnostic"
      }, commonAvailability),
      connectivity: Object.assign({
        platform: "binary_sensor",
        name: "Connectivity",
        unique_id: uniqueBase + "_connectivity",
        default_entity_id: "binary_sensor." + entityBase + "_connectivity",
        state_topic: topics.connectivity,
        value_template: "{{ value_json.state }}",
        json_attributes_topic: topics.connectivity,
        payload_on: STATE_ON,
        payload_off: STATE_OFF,
        device_class: "connectivity",
        entity_category: "diagnostic"
      }, commonAvailability),
      action: Object.assign({
        platform: "event",
        name: "Action",
        unique_id: uniqueBase + "_action",
        default_entity_id: "event." + entityBase + "_action",
        state_topic: topics.event,
        event_types: [CLICK_SINGLE, CLICK_DOUBLE, CLICK_HOLD]
      }, commonAvailability),
      single_press: {
        platform: "device_automation",
        automation_type: "trigger",
        type: "button_short_press",
        subtype: "button_1",
        topic: topics.action,
        payload: CLICK_SINGLE
      },
      double_press: {
        platform: "device_automation",
        automation_type: "trigger",
        type: "button_double_press",
        subtype: "button_1",
        topic: topics.action,
        payload: CLICK_DOUBLE
      },
      long_press: {
        platform: "device_automation",
        automation_type: "trigger",
        type: "button_long_press",
        subtype: "button_1",
        topic: topics.action,
        payload: CLICK_HOLD
      }
    }
  };

  publishJson(discoveryTopic("button_" + buttonKey), payload, true);
}

function publishButtonState(button) {
  const buttonKey = getButtonKey(button);
  publishJson(
    getButtonTopics(buttonKey).state,
    getStatePayload(button, buttonStateByButton[buttonKey] || STATE_OFF),
    true
  );
}

function publishButtonBattery(button) {
  const battery = button.batteryStatus == null ? STATE_UNKNOWN : button.batteryStatus;
  const payload = getStatePayload(button, battery);
  if (battery !== STATE_UNKNOWN) {
    payload.icon = getBatteryIcon(Number(battery));
  }
  publishJson(getButtonTopics(getButtonKey(button)).battery, payload, true);
}

function publishButtonConnectivity(button) {
  publishJson(
    getButtonTopics(getButtonKey(button)).connectivity,
    getStatePayload(button, button.ready ? STATE_ON : STATE_OFF),
    true
  );
}

function publishButtonAction(button, clickType) {
  const topics = getButtonTopics(getButtonKey(button));
  const eventPayload = getIdentityAttributes(button);
  eventPayload.event_type = clickType;
  eventPayload.click_type = clickType;
  eventPayload.timestamp = new Date().toISOString();

  // The JSON event feeds Home Assistant's MQTT event entity. The short action
  // value feeds its device automation triggers and is deliberately not retained.
  publishJson(topics.event, eventPayload, false);
  publish(topics.action, clickType, false);
}

function removeButton(event) {
  const address = String(event.bdaddr || "").toLowerCase();
  const cached = knownButtonsByAddress[address];
  const buttonKey = cached ? cached.key : sanitizeTopicPart(address.replace(/:/g, ""), "unknown");
  const topics = getButtonTopics(buttonKey);

  pendingRemovalKeys[buttonKey] = true;
  if (mqttClient && mqttClient.isConnected()) {
    clearButtonTopics(buttonKey, topics);
    delete pendingRemovalKeys[buttonKey];
  }

  delete knownButtonsByAddress[address];
  delete buttonStateByButton[buttonKey];
  delete lastEventTimestampByButton[buttonKey];
  console.log("Removed MQTT discovery and retained state for Flic " + buttonKey + ".");
}

function flushPendingRemovals() {
  const keys = Object.keys(pendingRemovalKeys);
  for (let index = 0; index < keys.length; index += 1) {
    clearButtonTopics(keys[index], getButtonTopics(keys[index]));
    delete pendingRemovalKeys[keys[index]];
  }
}

function clearButtonTopics(buttonKey, topics) {
  publish(discoveryTopic("button_" + buttonKey), "", true);
  publish(topics.state, "", true);
  publish(topics.battery, "", true);
  publish(topics.connectivity, "", true);
}

function rememberButton(button) {
  if (button && button.bdaddr) {
    knownButtonsByAddress[String(button.bdaddr).toLowerCase()] = {
      key: getButtonKey(button),
      name: getButtonFriendlyName(button)
    };
  }
}

function getButtonTopics(buttonKey) {
  const base = hubBaseTopic + "/button/" + buttonKey;
  return {
    state: base + "/state",
    battery: base + "/battery",
    connectivity: base + "/connectivity",
    event: base + "/event",
    action: base + "/action"
  };
}

function discoveryTopic(objectId) {
  return trimTopic(CONFIG.HOME_ASSISTANT_DISCOVERY_PREFIX) +
    "/device/" + discoveryNode + "/" + objectId + "/config";
}

function getStatePayload(button, state) {
  const payload = getIdentityAttributes(button);
  payload.state = state;
  return payload;
}

function getIdentityAttributes(button) {
  return {
    flic_name: getButtonFriendlyName(button),
    button_address: String(button.bdaddr || ""),
    button_serial_number: button.serialNumber == null ? null : String(button.serialNumber),
    hub_name: hubName,
    hub_serial_number: hubSerial
  };
}

function getOrigin() {
  return {
    name: "Flic Hub Home Assistant MQTT bridge",
    sw_version: MODULE_VERSION,
    support_url: "https://github.com/tjuuljensen/flic-hub-home-assistant"
  };
}

function getHubDeviceIdentifier() {
  return "flic_hub_" + hubKey;
}

function getButtonDeviceIdentifier(button) {
  const uuid = String(button.uuid || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return uuid ? "flic_button_" + uuid : "flic_button_" + getButtonKey(button);
}

function getButtonKey(button) {
  return sanitizeTopicPart(String(button.bdaddr || "").replace(/:/g, ""), "unknown");
}

function getButtonFriendlyName(button) {
  const name = button && button.name != null ? String(button.name).trim() : "";
  return name || "Flic " + getButtonKey(button);
}

function getButtonModel(button) {
  let model = "Flic Button";
  if (button.flicVersion != null) {
    model += " " + String(button.flicVersion);
  }
  if (button.color) {
    model += " " + String(button.color);
  }
  return model;
}

function getBatteryIcon(batteryLevel) {
  if (batteryLevel >= 95) {
    return "mdi:battery";
  }
  if (batteryLevel <= CONFIG.LOW_BATTERY_PERCENT) {
    return "mdi:battery-alert";
  }
  return "mdi:battery-" + Math.floor(batteryLevel / 10) * 10;
}

function sanitizeTopicPart(value, fallback) {
  // This value is also used in requested entity IDs, so keep it within Home
  // Assistant's stricter lowercase alphanumeric/underscore object-ID format.
  const sanitized = String(value || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  return sanitized || fallback;
}

function trimTopic(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function publishJson(topic, value, retain) {
  publish(topic, JSON.stringify(value), retain);
}

function publish(topic, message, retain) {
  if (!mqttClient || !mqttClient.isConnected()) {
    console.log("Skipped MQTT publish while disconnected: " + topic);
    return;
  }
  mqttClient.publish(topic, String(message), { retain: retain === true });
  if (CONFIG.LOG_PUBLISHES) {
    console.log("MQTT publish " + topic + (retain ? " (retained)" : ""));
  }
}

// -----------------------------------------------------------------------------
// BUNDLED MQTT 3.1.1 TRANSPORT
//
// Kept in this file so Hub Studio installation remains a one-file copy. This
// is a deliberately small plain-TCP client: CONNECT with credentials and Last
// Will, QoS 0 PUBLISH, QoS 0 SUBSCRIBE, keepalive, and reconnect notifications.
// It does not implement TLS or guaranteed QoS 1/2 delivery.
// -----------------------------------------------------------------------------

function createMqttClient(server, options) {
  return new BundledMqttClient(server, options || {});
}

function BundledMqttClient(server, options) {
  this.server = server;
  this.port = options.port || 1883;
  this.clientId = String(options.clientId || "flic-ha-client");
  this.keepAlive = options.keepAlive || 60;
  this.username = options.username == null ? null : String(options.username);
  this.password = options.password == null ? null : String(options.password);
  this.will = options.will || null;
  this.socket = null;
  this.connected = false;
  this.listeners = {};
  this.receiveBuffer = [];
  this.packetId = Math.floor(Math.random() * 65534) + 1;
  this.connectTimer = null;
  this.pingTimer = null;
  this.closeReported = false;
}

BundledMqttClient.prototype.on = function (eventName, callback) {
  if (!this.listeners[eventName]) {
    this.listeners[eventName] = [];
  }
  this.listeners[eventName].push(callback);
};

BundledMqttClient.prototype.emit = function (eventName) {
  const listeners = this.listeners[eventName] || [];
  const args = Array.prototype.slice.call(arguments, 1);
  for (let index = 0; index < listeners.length; index += 1) {
    try {
      listeners[index].apply(null, args);
    } catch (error) {
      console.log("MQTT listener error for " + eventName + ": " + String(error));
    }
  }
};

BundledMqttClient.prototype.isConnected = function () {
  return this.connected;
};

BundledMqttClient.prototype.connect = function () {
  if (this.socket || this.connected) {
    return;
  }

  const self = this;
  const net = require("net");
  this.closeReported = false;
  this.receiveBuffer = [];

  try {
    this.socket = net.connect({ host: this.server, port: this.port }, function () {
      self.writePacket(buildConnectPacket(self));
      self.connectTimer = setTimeout(function () {
        self.emit("error", "Timed out waiting for MQTT CONNACK.");
        self.closeSocket();
      }, 10000);
    });
    this.socket.on("data", function (data) {
      self.handleData(data);
    });
    this.socket.on("error", function (error) {
      self.emit("error", error && error.message ? error.message : String(error));
      self.closeSocket();
    });
    this.socket.on("end", function () {
      self.closeSocket();
    });
    this.socket.on("close", function () {
      self.closeSocket();
    });
  } catch (error) {
    this.emit("error", error && error.message ? error.message : String(error));
    this.closeSocket();
  }
};

BundledMqttClient.prototype.disconnect = function () {
  if (this.connected) {
    this.writePacket([0xe0, 0x00]);
  }
  this.closeSocket();
};

BundledMqttClient.prototype.closeSocket = function () {
  const hadConnection = this.connected || this.socket !== null;
  this.connected = false;
  if (this.connectTimer !== null) {
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }
  if (this.pingTimer !== null) {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  const socket = this.socket;
  this.socket = null;
  if (socket) {
    try {
      socket.end();
    } catch (error) {
      // The socket is already closed; reconnect handling below is sufficient.
    }
  }

  if (hadConnection && !this.closeReported) {
    this.closeReported = true;
    this.emit("disconnected");
  }
};

BundledMqttClient.prototype.publish = function (topic, message, options) {
  if (!this.connected) {
    return;
  }
  const retainFlag = options && options.retain ? 0x01 : 0x00;
  const body = encodeMqttString(topic).concat(encodeUtf8(message));
  this.writePacket(buildMqttPacket(0x30 | retainFlag, body));
};

BundledMqttClient.prototype.subscribe = function (topic) {
  if (!this.connected) {
    return;
  }
  const packetId = this.nextPacketId();
  const body = [packetId >> 8, packetId & 0xff]
    .concat(encodeMqttString(topic))
    .concat([0x00]);
  this.writePacket(buildMqttPacket(0x82, body));
};

BundledMqttClient.prototype.nextPacketId = function () {
  this.packetId = this.packetId >= 65535 ? 1 : this.packetId + 1;
  return this.packetId;
};

BundledMqttClient.prototype.writePacket = function (bytes) {
  if (!this.socket) {
    return;
  }
  try {
    this.socket.write(Buffer.from(bytes));
  } catch (error) {
    this.emit("error", error && error.message ? error.message : String(error));
    this.closeSocket();
  }
};

BundledMqttClient.prototype.handleData = function (data) {
  const incoming = Array.prototype.slice.call(data);
  this.receiveBuffer = this.receiveBuffer.concat(incoming);

  while (this.receiveBuffer.length >= 2) {
    const lengthInfo = decodeRemainingLength(this.receiveBuffer, 1);
    if (lengthInfo === null) {
      return;
    }
    const packetLength = 1 + lengthInfo.bytesUsed + lengthInfo.value;
    if (this.receiveBuffer.length < packetLength) {
      return;
    }

    const packet = this.receiveBuffer.slice(0, packetLength);
    this.receiveBuffer = this.receiveBuffer.slice(packetLength);
    this.handlePacket(packet, 1 + lengthInfo.bytesUsed, lengthInfo.value);
  }
};

BundledMqttClient.prototype.handlePacket = function (packet, bodyOffset, bodyLength) {
  const packetType = packet[0] >> 4;
  const flags = packet[0] & 0x0f;
  const body = packet.slice(bodyOffset, bodyOffset + bodyLength);

  if (packetType === 2) {
    const returnCode = body.length > 1 ? body[1] : 255;
    if (returnCode !== 0) {
      this.emit("error", "Broker refused MQTT connection (code " + returnCode + ").");
      this.closeSocket();
      return;
    }
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.connected = true;
    this.closeReported = false;
    const self = this;
    this.pingTimer = setInterval(function () {
      self.writePacket([0xc0, 0x00]);
    }, Math.max(10, this.keepAlive - 5) * 1000);
    this.emit("connected");
    return;
  }

  if (packetType === 3 && body.length >= 2) {
    const topicLength = (body[0] << 8) | body[1];
    const qos = (packet[0] >> 1) & 0x03;
    let messageOffset = 2 + topicLength;
    if (qos > 0) {
      messageOffset += 2;
    }
    const topic = decodeUtf8(body.slice(2, 2 + topicLength));
    const message = decodeUtf8(body.slice(messageOffset));
    this.emit("message", topic, message, Boolean(flags & 0x01));
    return;
  }

  // SUBACK (9) and PINGRESP (13) require no bridge-level handling.
  if (packetType !== 9 && packetType !== 13) {
    this.emit("error", "Unsupported MQTT packet type " + packetType + ".");
  }
};

function buildConnectPacket(client) {
  let flags = 0x02; // Clean session.
  let payload = encodeMqttString(client.clientId);

  if (client.will) {
    flags |= 0x04;
    if (client.will.retain) {
      flags |= 0x20;
    }
    payload = payload
      .concat(encodeMqttString(client.will.topic))
      .concat(encodeMqttString(client.will.message));
  }
  if (client.username !== null) {
    flags |= 0x80;
  }
  if (client.password !== null) {
    flags |= 0x40;
  }
  if (client.username !== null) {
    payload = payload.concat(encodeMqttString(client.username));
  }
  if (client.password !== null) {
    payload = payload.concat(encodeMqttString(client.password));
  }

  const variableHeader = encodeMqttString("MQTT")
    .concat([0x04, flags, client.keepAlive >> 8, client.keepAlive & 0xff]);
  return buildMqttPacket(0x10, variableHeader.concat(payload));
}

function buildMqttPacket(header, body) {
  return [header].concat(encodeRemainingLength(body.length)).concat(body);
}

function encodeRemainingLength(length) {
  const bytes = [];
  let remaining = length;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      digit |= 0x80;
    }
    bytes.push(digit);
  } while (remaining > 0);
  return bytes;
}

function decodeRemainingLength(bytes, offset) {
  let multiplier = 1;
  let value = 0;
  let used = 0;
  while (used < 4) {
    if (offset + used >= bytes.length) {
      return null;
    }
    const digit = bytes[offset + used];
    value += (digit & 0x7f) * multiplier;
    used += 1;
    if ((digit & 0x80) === 0) {
      return { value: value, bytesUsed: used };
    }
    multiplier *= 128;
  }
  throw new Error("Malformed MQTT remaining length.");
}

function encodeMqttString(value) {
  const bytes = encodeUtf8(String(value));
  if (bytes.length > 65535) {
    throw new Error("MQTT string exceeds 65535 bytes.");
  }
  return [bytes.length >> 8, bytes.length & 0xff].concat(bytes);
}

function encodeUtf8(value) {
  const bytes = [];
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      }
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18));
      bytes.push(0x80 | ((codePoint >> 12) & 0x3f));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    }
  }
  return bytes;
}

function decodeUtf8(bytes) {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 1) {
    encoded += "%" + (bytes[index] < 16 ? "0" : "") + bytes[index].toString(16);
  }
  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    let fallback = "";
    for (let index = 0; index < bytes.length; index += 1) {
      fallback += String.fromCharCode(bytes[index]);
    }
    return fallback;
  }
}

// Start only after the bundled transport's prototype has been fully assigned.
start();

/*
 * MIT License
 *
 * Copyright (c) 2013 Gordon Williams, Pur3 Ltd
 * Modified by Flic Shortcut Labs.
 * Copyright (c) 2026 Torsten Juul-Jensen
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
