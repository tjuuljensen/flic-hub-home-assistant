# Mosquitto add-on ACL configuration

This guide configures the official Home Assistant Mosquitto broker add-on for:

- One general-purpose MQTT account named `mqtt_other`.
- A dedicated account for a Kitchen Flic Hub.
- A dedicated account for an Upstairs Flic Hub.
- Intended topic restrictions for each Flic Hub account.

The Flic MQTT bridge uses plain TCP, so keep broker port `1883` available only
on a trusted or segmented local network. Do not expose it to the internet.

## Important ACL limitation

The official add-on documents custom ACL files, but an
[open Mosquitto add-on 7.1.0 issue](https://github.com/home-assistant/addons/issues/4721)
reports that these restrictions can be bypassed for plugin-authenticated users.
Separate usernames remain useful for credential rotation and auditing, but do
not assume that they provide least-privilege topic isolation.

After configuration, perform both the allowed and forbidden tests in this guide.
If the forbidden operation succeeds, use a broker deployment with ACL behavior
that can be configured and verified.

## 1. Create the broker users

Open **Settings > Apps > Mosquitto broker > Configuration** and use:

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
  active: true
  folder: mosquitto
certfile: fullchain.pem
keyfile: privkey.pem
require_certificate: false
```

Replace all password placeholders with different strong random values. Do not
use the reserved usernames `homeassistant` or `addons`. Home Assistant manages
those internal broker accounts automatically, so they must not be added under
`logins`.

The add-on also supports pre-hashed local-login passwords. See the
[official Mosquitto add-on documentation](https://github.com/home-assistant/addons/blob/master/mosquitto/DOCS.md)
for the current `password_pre_hashed` procedure.

Do not restart the add-on until both ACL files below have been created. Enabling
customization with a missing or invalid referenced file can prevent Mosquitto
from starting.

## 2. Create the custom configuration file

Create the following directory and files through the Samba `share` folder or
another method that provides access to Home Assistant's `/share` directory:

```text
/share/mosquitto/
|-- acl.conf
`-- accesscontrollist
```

The add-on host path corresponding to `/share` is normally
`/usr/share/hassio/share`. The `.conf` extension is required because the add-on
loads configuration fragments from the configured customization folder.

Put this in `/share/mosquitto/acl.conf`:

```text
acl_file /share/mosquitto/accesscontrollist
```

## 3. Determine the two hub keys

Run the configured MQTT module on each hub once and read its Hub Studio startup
message:

```text
Flic Home Assistant MQTT bridge ...; state topic flic/HUB_KEY.
```

The part following `flic/` is the sanitized hub serial used in both state and
discovery topics. Record the exact value for each hub.

For example, a startup message containing:

```text
state topic flic/1234567890
```

uses the hub key `1234567890`.

## 4. Create the access-control list

Put the following in `/share/mosquitto/accesscontrollist`:

```text
user addons
topic readwrite #

user homeassistant
topic readwrite #

user mqtt_other
topic readwrite #

user flic_hub_kitchen
topic write flic/KITCHEN_HUB_KEY/#
topic write homeassistant/device/flic_KITCHEN_HUB_KEY/#
topic read homeassistant/status

user flic_hub_upstairs
topic write flic/UPSTAIRS_HUB_KEY/#
topic write homeassistant/device/flic_UPSTAIRS_HUB_KEY/#
topic read homeassistant/status
```

Replace `KITCHEN_HUB_KEY` and `UPSTAIRS_HUB_KEY` with the exact values recorded
from Hub Studio. Do not include angle brackets or add another `flic_` prefix.

The two reserved add-on accounts retain unrestricted access because the official
add-on requires it. The shared `mqtt_other` user also has unrestricted access by
design. The Flic accounts receive only:

- Write access to their own state, action, and availability tree.
- Write access to their own Home Assistant discovery tree.
- Read access to `homeassistant/status` for Home Assistant birth detection.

They do not require general subscription access.

## 5. Restart and inspect Mosquitto

Save the add-on configuration and restart the Mosquitto broker add-on. Inspect
its log and confirm that it loads:

```text
/share/mosquitto/acl.conf
```

If Mosquitto does not start, set `customize.active` back to `false`, restart the
add-on, and correct the file paths or syntax before trying again.

After Mosquitto starts, restart both Flic Hub modules and confirm their
`MQTT connected` messages.

## 6. Verify the ACL

Use `mosquitto_pub` from a computer with Mosquitto client tools. First verify an
allowed Kitchen Hub topic:

```shell
mosquitto_pub -h 192.168.1.10 -p 1883 \
  -u flic_hub_kitchen -P "KITCHEN_PASSWORD" \
  -t "flic/KITCHEN_HUB_KEY/acl-test" -m "allowed"
```

Then try to publish to a topic outside the Kitchen Hub tree:

```shell
mosquitto_pub -h 192.168.1.10 -p 1883 \
  -u flic_hub_kitchen -P "KITCHEN_PASSWORD" \
  -t "flic/UPSTAIRS_HUB_KEY/acl-test" -m "must-fail"
```

Finally, try an unauthorized general subscription:

```shell
mosquitto_sub -h 192.168.1.10 -p 1883 \
  -u flic_hub_kitchen -P "KITCHEN_PASSWORD" \
  -t "#" -C 1 -W 5
```

Replace the broker address, passwords, and hub keys. The first publish must
succeed. The second publish and general subscription must be rejected. A timeout
alone does not prove that the subscription was rejected; inspect the command
error and broker log for an explicit authorization failure.

Also verify that each Flic Hub still appears in Home Assistant, republishes
discovery after an HA restart, and reports `offline` when its module is stopped
or network access is removed.

## If the forbidden test succeeds

The ACL is not isolating the users, even if the custom file appears in the
Mosquitto log. In that situation:

1. Do not rely on the Flic accounts as least-privilege credentials.
2. Keep the broker and Flic Hubs on a trusted or segmented local network.
3. Retain separate usernames so each hub password can still be rotated or
   revoked independently.
4. If strict isolation is required, use a standalone broker or another broker
   deployment where standard ACL enforcement has been confirmed.

The MQTT approach still avoids storing a Home Assistant administrator token on
the hub, but unrestricted MQTT credentials can potentially observe or control
other MQTT-integrated devices and must still be protected.

## Rollback

To disable the custom ACL configuration:

1. Set `customize.active: false` in the Mosquitto add-on configuration.
2. Restart the add-on.
3. Confirm that Home Assistant and required MQTT clients reconnect.

The files under `/share/mosquitto` may remain for later troubleshooting; they
are ignored while customization is disabled. Disabling the ACL does not remove
the local users defined under `logins`.

