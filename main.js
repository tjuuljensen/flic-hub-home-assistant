/*
 * Flic Hub to Home Assistant - single-file module
 *
 * Purpose:
 *   Forward Flic button states, battery levels, connectivity, and click events
 *   from Flic Hub Studio to the Home Assistant REST API.
 *
 * Behavior:
 *   - Creates these Home Assistant states for every paired button:
 *       binary_sensor.flic_<address>
 *       sensor.flic_<address>_battery
 *       binary_sensor.flic_<address>_connectivity
 *   - Fires a flic_click event with a stable button_name, the Flic app's
 *     button_friendly_name, button_address, and click_type.
 *   - Republishes all states at a configurable interval so REST-created
 *     entities return automatically after a Home Assistant restart.
 *   - Adds the configured hub name and SDK-provided hub serial number to every
 *     state and click event, allowing multiple hubs to be distinguished.
 *   - Deletes the three Home Assistant states when a button is removed.
 *
 * Usage:
 *   1. Ensure Home Assistant has the `api:` integration enabled.
 *   2. Create a Home Assistant long-lived access token from your user profile.
 *   3. In Flic Hub Studio, create a package and replace its main.js with this file.
 *      Hub Studio creates module.json automatically; leave it as generated.
 *      Its version describes the Studio package container, while this file
 *      logs the bridge version at startup. No other source files are needed.
 *   4. Edit only the USER CONFIGURATION section below, then run the package.
 *   5. Confirm successful startup and requests in the Hub Studio console.
 *
 * Inputs:
 *   Paired Flic buttons and the CONFIG values below.
 *
 * Outputs and side effects:
 *   Authenticated HTTP requests create/update/delete Home Assistant states and
 *   fire events. The access token is intentionally never written to the log.
 *
 * Prerequisites:
 *   A Flic Hub with Hub Studio/SDK access, network access to Home Assistant,
 *   and a Home Assistant long-lived access token.
 *
 * Version: 1.2.0
 * Changelog:
 *   1.2.0 - Republish all button states periodically for Home Assistant restart
 *           recovery; add hub identity to states, events, and dashboard data.
 *   1.1.0 - Added Flic app names to events and state attributes, and refresh
 *           Home Assistant names when the SDK reports buttonUpdated.
 *   1.0.0 - Combined upstream 1.2.6 files; added configuration validation,
 *           null guards, concise status-aware logging, and token-safe logs.
 *
 * Derived from:
 *   https://github.com/blunan/flic-hub-home-assistant-module
 *   Upstream version 1.2.6, reviewed at commit
 *   b944896861ac88b5263936f390e6873c2ab6d90b.
 * Full MIT license text is retained at the end of this standalone file.
 */

// -----------------------------------------------------------------------------
// USER CONFIGURATION - edit these values in the copy stored on the Flic Hub.
// Keep the repository copy token-free.
// -----------------------------------------------------------------------------

const CONFIG = {
  // The Flic Hub SDK does not expose the hub name assigned in the Flic app.
  // Set a unique, friendly name in each hub's copy, for example "Kitchen Hub".
  // Leave blank to use "Flic Hub <serial number>" automatically.
  HUB_NAME: "",

  // Include http:// or https:// and the Home Assistant port when required.
  // Do not add /api or a trailing slash.
  HOME_ASSISTANT_URL: "http://192.168.1.10:8123",

  // Home Assistant profile -> Security -> Long-lived access tokens.
  // Treat this token like a password. It grants the permissions of its owner.
  HOME_ASSISTANT_TOKEN: "PASTE_LONG_LIVED_ACCESS_TOKEN_HERE",

  // Upstream compatibility filter. Set to 0 only if your Hub reliably emits
  // exactly one single/double/hold event and rapid consecutive clicks matter.
  EVENT_DEBOUNCE_MS: 600,

  // Republish every button, battery, and connectivity state at this interval.
  // This recreates the REST states after Home Assistant restarts. With the
  // default, they can be absent for at most about one minute after HA is ready.
  STATUS_SYNC_INTERVAL_MS: 1 * 60 * 1000,

  // Battery percentages at or below this value use the alert icon.
  LOW_BATTERY_PERCENT: 8,

  // Successful-request logs are normally noise. Errors are always logged.
  LOG_SUCCESSFUL_REQUESTS: false,

  // For HTTPS with a private CA or self-signed certificate, enable this and
  // paste one or more PEM certificates below. Keep hostname validation enabled
  // unless the certificate cannot be corrected; disabling it weakens TLS.
  USE_CUSTOM_CERTIFICATE: false,
  VERIFY_CERTIFICATE_HOSTNAME: true,
  CUSTOM_CERTIFICATES_PEM: ""
};

// -----------------------------------------------------------------------------
// MODULE IMPLEMENTATION - normally no changes are needed below this line.
// -----------------------------------------------------------------------------

const http = require("http");
const buttonManager = require("buttons");
const hubInfo = require("hubinfo");

// This is the authoritative version of the bridge code copied to the hub.
// Hub Studio's automatically generated module.json may keep version 1.0.0.
const MODULE_VERSION = "1.2.0";
const CLICK_SINGLE = "single";
const CLICK_DOUBLE = "double";
const CLICK_HOLD = "hold";
const STATE_ON = "on";
const STATE_OFF = "off";

// The timestamp map is intentionally in memory. A package restart clears old
// debounce state so the first click after restart is never discarded.
const lastEventTimestampByButton = {};
const buttonStateByButton = {};
let homeAssistantUrl;
let hubName;

start();

function start() {
  validateConfiguration();
  homeAssistantUrl = CONFIG.HOME_ASSISTANT_URL.replace(/\/+$/, "");
  hubName = getHubName();

  const buttons = buttonManager.getButtons();
  for (let index = 0; index < buttons.length; index += 1) {
    initializeButton(buttons[index]);
  }

  registerButtonListeners();
  setInterval(syncAllButtonStates, CONFIG.STATUS_SYNC_INTERVAL_MS);

  console.log(
    "Flic Home Assistant bridge v" + MODULE_VERSION + " started as " +
    hubName + " for " + buttons.length + " button(s)."
  );
}

function validateConfiguration() {
  const errors = [];
  const url = String(CONFIG.HOME_ASSISTANT_URL || "").trim();
  const token = String(CONFIG.HOME_ASSISTANT_TOKEN || "").trim();

  if (typeof CONFIG.HUB_NAME !== "string") {
    errors.push("HUB_NAME must be a string (it may be blank).");
  }

  if (!/^https?:\/\/[^/]/.test(url)) {
    errors.push("HOME_ASSISTANT_URL must start with http:// or https://.");
  }
  if (/\/api\/?$/.test(url)) {
    errors.push("HOME_ASSISTANT_URL must not end with /api.");
  }
  if (!token || token === "PASTE_LONG_LIVED_ACCESS_TOKEN_HERE") {
    errors.push("HOME_ASSISTANT_TOKEN still contains the placeholder value.");
  }
  if (!isNonNegativeNumber(CONFIG.EVENT_DEBOUNCE_MS)) {
    errors.push("EVENT_DEBOUNCE_MS must be zero or a positive number.");
  }
  if (!isPositiveNumber(CONFIG.STATUS_SYNC_INTERVAL_MS)) {
    errors.push("STATUS_SYNC_INTERVAL_MS must be a positive number.");
  }
  if (
    !isNonNegativeNumber(CONFIG.LOW_BATTERY_PERCENT) ||
    CONFIG.LOW_BATTERY_PERCENT > 100
  ) {
    errors.push("LOW_BATTERY_PERCENT must be between 0 and 100.");
  }
  if (
    CONFIG.USE_CUSTOM_CERTIFICATE &&
    !String(CONFIG.CUSTOM_CERTIFICATES_PEM || "").trim()
  ) {
    errors.push(
      "CUSTOM_CERTIFICATES_PEM is required when USE_CUSTOM_CERTIFICATE is true."
    );
  }

  if (errors.length > 0) {
    for (let index = 0; index < errors.length; index += 1) {
      console.log("Configuration error: " + errors[index]);
    }
    throw new Error("Flic Home Assistant bridge configuration is invalid.");
  }
}

function isPositiveNumber(value) {
  return typeof value === "number" && isFinite(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && isFinite(value) && value >= 0;
}

function registerButtonListeners() {
  buttonManager.on("buttonConnected", function (event) {
    withButton(event.bdaddr, "buttonConnected", initializeButton);
  });

  // buttonUpdated is emitted after changes such as renaming a button in the
  // Flic app. Refresh every Home Assistant state without resetting debounce.
  buttonManager.on("buttonUpdated", function (event) {
    if (event.button) {
      refreshButtonStates(event.button);
      return;
    }
    withButton(event.bdaddr, "buttonUpdated", refreshButtonStates);
  });

  buttonManager.on("buttonDeleted", function (event) {
    deleteButton(event);
  });

  buttonManager.on("buttonReady", function (event) {
    withButton(event.bdaddr, "buttonReady", sendButtonConnectivityState);
  });

  buttonManager.on("buttonDisconnected", function (event) {
    withButton(event.bdaddr, "buttonDisconnected", sendButtonConnectivityState);
  });

  buttonManager.on("buttonDown", function (event) {
    withButton(event.bdaddr, "buttonDown", function (button) {
      setButtonState(button, STATE_ON);
    });
  });

  buttonManager.on("buttonUp", function (event) {
    withButton(event.bdaddr, "buttonUp", function (button) {
      setButtonState(button, STATE_OFF);
    });
  });

  buttonManager.on("buttonSingleOrDoubleClickOrHold", function (event) {
    const button = getButton(event.bdaddr, "button click");
    if (button === null) {
      return;
    }

    const buttonName = getButtonEntityName(button);
    const timestamp = Date.now();
    const lastTimestamp = lastEventTimestampByButton[buttonName] || 0;

    if (timestamp - lastTimestamp < CONFIG.EVENT_DEBOUNCE_MS) {
      console.log(
        "Ignored a duplicate event for " + getButtonFriendlyName(button) +
        "; previous event was " + (timestamp - lastTimestamp) + " ms earlier."
      );
      return;
    }

    lastEventTimestampByButton[buttonName] = timestamp;
    const clickType = event.isSingleClick
      ? CLICK_SINGLE
      : event.isDoubleClick
        ? CLICK_DOUBLE
        : CLICK_HOLD;

    sendButtonEvent(button, clickType);
  });
}

function withButton(address, context, callback) {
  const button = getButton(address, context);
  if (button !== null) {
    callback(button);
  }
}

function getButton(address, context) {
  const button = buttonManager.getButton(address);
  if (button === null) {
    console.log(
      "Ignored " + context + " for unknown Flic address " + String(address) + "."
    );
  }
  return button;
}

function initializeButton(button) {
  const buttonName = getButtonEntityName(button);
  lastEventTimestampByButton[buttonName] = Date.now() - CONFIG.EVENT_DEBOUNCE_MS;

  setButtonState(button, STATE_OFF);
  sendButtonBatteryState(button);
  sendButtonConnectivityState(button);
}

function refreshButtonStates(button) {
  const buttonName = getButtonEntityName(button);
  const state = Object.prototype.hasOwnProperty.call(buttonStateByButton, buttonName)
    ? buttonStateByButton[buttonName]
    : STATE_OFF;

  sendButtonState(button, state);
  sendButtonBatteryState(button);
  sendButtonConnectivityState(button);
}

function setButtonState(button, state) {
  buttonStateByButton[getButtonEntityName(button)] = state;
  sendButtonState(button, state);
}

function syncAllButtonStates() {
  // States posted through /api/states have no owning HA integration and are not
  // restored to HA's state machine after a restart. Republishing all states -
  // including the main button state - makes them return without user action.
  const buttons = buttonManager.getButtons();
  for (let index = 0; index < buttons.length; index += 1) {
    refreshButtonStates(buttons[index]);
  }
}

function deleteButton(buttonReference) {
  const buttonName = getButtonEntityName(buttonReference);
  delete lastEventTimestampByButton[buttonName];
  delete buttonStateByButton[buttonName];

  requestHomeAssistant(
    "DELETE",
    "/api/states/binary_sensor." + buttonName,
    undefined,
    "delete button state"
  );
  requestHomeAssistant(
    "DELETE",
    "/api/states/sensor." + buttonName + "_battery",
    undefined,
    "delete battery state"
  );
  requestHomeAssistant(
    "DELETE",
    "/api/states/binary_sensor." + buttonName + "_connectivity",
    undefined,
    "delete connectivity state"
  );
}

function sendButtonState(button, state) {
  requestHomeAssistant(
    "POST",
    "/api/states/binary_sensor." + getButtonEntityName(button),
    {
      state: state,
      attributes: getButtonIdentityAttributes(button)
    },
    "update button state"
  );
}

function sendButtonBatteryState(button) {
  // Preserve upstream compatibility: an unknown SDK battery value is exposed
  // as 0 rather than the string "unknown".
  const battery = button.batteryStatus == null ? 0 : button.batteryStatus;

  requestHomeAssistant(
    "POST",
    "/api/states/sensor." + getButtonEntityName(button) + "_battery",
    {
      state: battery,
      attributes: {
        ...getButtonIdentityAttributes(button, "Battery"),
        device_class: "battery",
        unit_of_measurement: "%",
        icon: getBatteryIcon(battery)
      }
    },
    "update battery state"
  );
}

function sendButtonConnectivityState(button) {
  requestHomeAssistant(
    "POST",
    "/api/states/binary_sensor." + getButtonEntityName(button) + "_connectivity",
    {
      state: button.ready ? STATE_ON : STATE_OFF,
      attributes: {
        ...getButtonIdentityAttributes(button, "Connectivity"),
        device_class: "connectivity",
        icon: button.ready ? "mdi:bluetooth" : "mdi:bluetooth-off"
      }
    },
    "update connectivity state"
  );
}

function sendButtonEvent(button, clickType) {
  requestHomeAssistant(
    "POST",
    "/api/events/flic_click",
    {
      button_name: getButtonEntityName(button),
      button_friendly_name: getButtonFriendlyName(button),
      button_address: button.bdaddr,
      hub_name: hubName,
      hub_serial_number: getHubSerialNumber(),
      click_type: clickType
    },
    "fire " + clickType + " click event"
  );
}

function requestHomeAssistant(method, path, payload, description) {
  const options = {
    method: method,
    url: homeAssistantUrl + path,
    headers: {
      Authorization: "Bearer " + CONFIG.HOME_ASSISTANT_TOKEN,
      "Content-Type": "application/json"
    }
  };

  if (payload !== undefined) {
    options.content = JSON.stringify(payload);
  }

  if (CONFIG.USE_CUSTOM_CERTIFICATE) {
    options.customTrustStore = {
      certList: CONFIG.CUSTOM_CERTIFICATES_PEM,
      validateHostname: CONFIG.VERIFY_CERTIFICATE_HOSTNAME
    };
  }

  http.makeRequest(options, function (error, result) {
    if (error != null) {
      console.log("Home Assistant request failed (" + description + "): " + error);
      return;
    }

    // The Flic SDK reports HTTP 4xx/5xx responses as completed requests, so the
    // status code must be checked explicitly.
    if (!result || result.statusCode < 200 || result.statusCode >= 300) {
      const status = result
        ? result.statusCode + " " + String(result.statusMessage || "")
        : "no response";
      const responseBody = result && result.content
        ? " - " + String(result.content).slice(0, 300)
        : "";
      console.log(
        "Home Assistant rejected request (" + description + "): " +
        status + responseBody
      );
      return;
    }

    if (CONFIG.LOG_SUCCESSFUL_REQUESTS) {
      console.log(
        "Home Assistant request succeeded (" + description + "): HTTP " +
        result.statusCode
      );
    }
  });
}

function getButtonEntityName(button) {
  return "flic_" + String(button.bdaddr).replace(/:/g, "").toLowerCase();
}

function getButtonFriendlyName(button, suffix) {
  let name = button.name == null || button.name === ""
    ? getButtonEntityName(button)
    : button.name;

  if (suffix !== undefined) {
    name += " " + suffix;
  }
  return name;
}

function getButtonIdentityAttributes(button, suffix) {
  return {
    friendly_name: getButtonFriendlyName(button, suffix),
    flic_name: getButtonFriendlyName(button),
    button_address: button.bdaddr,
    hub_name: hubName,
    hub_serial_number: getHubSerialNumber()
  };
}

function getHubName() {
  const configuredName = String(CONFIG.HUB_NAME || "").trim();
  return configuredName || "Flic Hub " + getHubSerialNumber();
}

function getHubSerialNumber() {
  return String(hubInfo.serialNumber || "unknown");
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

/*
 * MIT License
 *
 * Copyright (c) 2021 Brayan Luna
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
