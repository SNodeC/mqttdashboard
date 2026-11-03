# MQTT topics and JSON message reference

This is the complete **provisional mock contract** used by the included dashboard.
The final device protocol is still to be defined. The authoritative examples are
this directory's ten JSON fixtures, with field constraints in
[`uplink.schema.json`](uplink.schema.json). The complete messages below are copied
from those fixtures. The host's external read/live adapter is
[`web/model.json`](../web/model.json), and MQTTStore's projection is
[`config/projections.json`](../config/projections.json).

## Topics and receiving path

The example application is `mock-lab`, in tenant `ttn`. Publish one complete uplink
JSON object on the topic for its device:

```text
v3/mock-lab@ttn/devices/solar-01/up
```

The subscription filter for all devices in that application is:

```text
v3/mock-lab@ttn/devices/+/up
```

`+` matches one device-ID level. There is no FPort in the topic: `f_port` inside the
JSON selects the measurement contract. FPorts 10/20/30/40/50 for `solar-01` all use
the same topic. The device ID in the envelope must agree with the topic chosen by
the publisher. The current dashboard obtains identities from the JSON pointers;
it does not compare payload IDs with the MQTT topic or derive identities from it.

| Component | Receives / forwards | Configuration |
| --- | --- | --- |
| Mock MQTT publisher | Publishes device uplinks to the simulated TTN broker, normally `127.0.0.1:18883` | Device topic shown above |
| MQTTBridge upstream connection | Subscribes to `v3/mock-lab@ttn/devices/+/up` | `config/bridge.mock.json`, upstream `topics` |
| MQTTBridge local connection | Publishes the same topic and payload to the local broker, normally `127.0.0.1:1883` | Local `topics: []`, empty prefixes |
| MQTTStore | Subscribes to the same `.../+/up` filter on the local broker | `config/mqttstore.conf`, `[in-mqtt.sub] topic` |
| MQTTStore projection | Selects the same topic filter and inserts the mapped fields into `ttn_uplinks` | `config/projections.json`, projection `topic` |
| MQTTDashboard | Subscribes to the same filter on the local broker | `config/dashboard.json` (or deployment `dashboard.local.json`), `topic` |
| Browser | Receives an initial database snapshot and subsequent SSE events over HTTP | `/api/events`; the browser does not subscribe to MQTT |

The bridge's local connection has no topic subscriptions, so local messages are
not forwarded back upstream. Topic/payload prefixes are empty. The subscription
QoS is 0; the example publisher should send without retain. Browser reconnects
recover stored state from MariaDB, rather than depending on retained MQTT messages.
The disposable development demo allocates separate free MQTT ports; consult its
running state instead of assuming the example ports above.

For real TTN, the same bridge shape uses the configured cluster's MQTT endpoint
and credentials from `config/bridge.example.json`; the dashboard and MQTTStore
still connect to the local broker. Other TTN event topics, downlink topics and
arbitrary application topics are outside the supplied uplink subscription. This
system does not publish downlinks or register devices through MQTT.

| Device / fixtures | Exact example topic |
| --- | --- |
| `solar-01`, all five `solar-*.json` files | `v3/mock-lab@ttn/devices/solar-01/up` |
| `node-01`, `fport-10.json`, `fport-20.json`, `fport-30.json` | `v3/mock-lab@ttn/devices/node-01/up` |
| `climate-01`, `climate-device.json` | `v3/mock-lab@ttn/devices/climate-01/up` |
| `energy-01`, `energy-device.json` | `v3/mock-lab@ttn/devices/energy-01/up` |

A new device can publish under any new device-ID level in the matching application.
Its first stored or live observation makes it discoverable. Keep the topic's
application/device and envelope IDs consistent; configured labels alone do not
create devices. The UI distinguishes identical device IDs in different applications.

## Required uplink envelope

Each MQTT payload is a UTF-8 JSON object, not a bare decoded-payload object, raw
LoRaWAN bytes or an SSE record. Every supplied message has these fields:

| JSON Pointer | Mock-contract type and meaning | Projected / live record field |
| --- | --- | --- |
| `/end_device_ids/application_ids/application_id` | String `mock-lab`; does not include `@ttn` | `application_id` |
| `/end_device_ids/device_id` | Nonempty device-ID string | `device_id` |
| `/received_at` | UTC source timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ` | `ttn_received_at` in SQL, `received_at` in SSE |
| `/uplink_message/session_key_id` | Nonempty session identity string | `session_id` |
| `/uplink_message/f_cnt` | Integer 0–4294967295, frame counter in that session | `frame_counter` |
| `/uplink_message/f_port` | Integer application FPort; supplied mock contracts use 10, 20, 30, 40, 50 | `fport` |
| `/uplink_message/decoded_payload` | JSON object described below | `decoded_payload` in SQL, `values` in SSE |

The decoded mock payload has `schema_version: 1`. Numeric measurements are JSON
numbers, not formatted strings with units. Optional `device_type` selects a known
site profile unless a device assignment overrides it. The solar GPS/radio schema
requires that metadata; include `device_type: "solar"` on every solar uplink for
reliable discovery without a configured assignment. Unknown profile names use the
site's generic profile. The included assignments explicitly select profiles for
`mock-lab/solar-01`, `mock-lab/climate-01` and `mock-lab/energy-01`.

Message identity is `(application_id, device_id, session_key_id, f_cnt, f_port)`.
Use a new frame counter for each new uplink in a session, and a new session identity
when the counter resets for a new session. Re-delivery of the same identity is not
a new measurement: raw storage can record it again, while the projection's unique
key prevents a second projected row. A stored observation wins over an unconfirmed
live re-delivery with the same identity. Source timestamps order measurements and
place them in the chart; arrival order does not replace newer source observations.

The JSON Schema is documentation and a development-validation aid. Neither
MQTTStore nor the dashboard runs full JSON Schema validation on incoming messages.
The live adapter requires its configured JSON Pointers, object-valued decoded
payloads and an application FPort in 1–223; malformed JSON or a missing configured
pointer is ignored by that live path. SQL constraints independently enforce the
projection contract. Additional envelope metadata is not used. The supplied mock
schema restricts decoded-payload fields to the documented fields; that restriction
is not an automatic runtime rejection policy. Do not rely on either service to
repair malformed or mismatched data. A raw/projection/live failure can have a
different result in each independent consumer.

## Solar V2 payloads

All five messages below are published on
`v3/mock-lab@ttn/devices/solar-01/up`. Each updates its own FPort observation.
The dashboard combines their latest available values for the selected device;
it does not require all five to arrive together.

| FPort | Required decoded fields in the supplied schema | Other decoded fields |
| --- | --- | --- |
| 10 | `schema_version`, `temperature_c`, `humidity_pct` | `device_type` |
| 20 | `schema_version`, `voltage_v`, `current_a`, `power_w` | `device_type` |
| 30 | `schema_version`, `battery_v`, `uptime_s`, `status` | `device_type`, `battery_pct` |
| 40 | `schema_version`, `device_type`, `gps` containing `fix` | GPS details below |
| 50 | `schema_version`, `device_type`, `lorawan` containing `configured` | Radio details below |

`humidity_pct` and `battery_pct` range from 0 to 100. `uptime_s` is a nonnegative
integer. Status is `ok`, `warning` or `fault`. `battery_v` is voltage in volts;
it is not converted into a battery-charge percentage. For the V2 battery indicator
provide `battery_pct`; header, dashboard card and guide resolve this same field.
`power_w` is the reported value and is not recalculated by the host from voltage
and current. Missing optional values show dashes rather than fabricated readings.

### FPort 10 — environment

Temperature in degrees Celsius and relative humidity in percent.

Fixture: [`solar-10.json`](solar-10.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "solar-01"
  },
  "received_at": "2026-11-03T12:08:01.000Z",
  "uplink_message": {
    "session_key_id": "mock-solar-session",
    "f_cnt": 10,
    "f_port": 10,
    "decoded_payload": {
      "schema_version": 1,
      "device_type": "solar",
      "temperature_c": 28,
      "humidity_pct": 48
    }
  }
}
```

### FPort 20 — electrical readings

Voltage in volts, current in amps and power in watts. These observations supply the twelve-minute voltage chart.

Fixture: [`solar-20.json`](solar-20.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "solar-01"
  },
  "received_at": "2026-11-03T12:08:02.000Z",
  "uplink_message": {
    "session_key_id": "mock-solar-session",
    "f_cnt": 20,
    "f_port": 20,
    "decoded_payload": {
      "schema_version": 1,
      "device_type": "solar",
      "voltage_v": 12.6,
      "current_a": 3.2,
      "power_w": 40.32
    }
  }
}
```

### FPort 30 — battery and device status

Battery voltage, estimated charge percentage, uptime in seconds and a diagnostic status. The diagnostic status is distinct from message-freshness and connection status.

Fixture: [`solar-30.json`](solar-30.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "solar-01"
  },
  "received_at": "2026-11-03T12:08:03.000Z",
  "uplink_message": {
    "session_key_id": "mock-solar-session",
    "f_cnt": 30,
    "f_port": 30,
    "decoded_payload": {
      "schema_version": 1,
      "device_type": "solar",
      "battery_pct": 82,
      "battery_v": 12.6,
      "uptime_s": 3600,
      "status": "ok"
    }
  }
}
```

### FPort 40 — GPS

A failed current fix can still include the previous successful position, explicitly labelled as the last known fix.

Fixture: [`solar-40.json`](solar-40.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "solar-01"
  },
  "received_at": "2026-11-03T12:08:04.000Z",
  "uplink_message": {
    "session_key_id": "mock-solar-session",
    "f_cnt": 40,
    "f_port": 40,
    "decoded_payload": {
      "schema_version": 1,
      "device_type": "solar",
      "gps": {
        "fix": false,
        "latitude": -26.2041,
        "longitude": 28.0473,
        "fix_received_at": "2026-11-03T12:00:00.000Z",
        "satellites": 7,
        "accuracy_m": 5
      }
    }
  }
}
```

### FPort 50 — LoRaWAN observation

These are mock decoder-provided fields. The dashboard does not extract these values from TTN gateway metadata or query TTN for them.

Fixture: [`solar-50.json`](solar-50.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "solar-01"
  },
  "received_at": "2026-11-03T12:08:05.000Z",
  "uplink_message": {
    "session_key_id": "mock-solar-session",
    "f_cnt": 50,
    "f_port": 50,
    "decoded_payload": {
      "schema_version": 1,
      "device_type": "solar",
      "lorawan": {
        "configured": true,
        "dev_eui": "70B3D57ED0012345",
        "network": "TTN",
        "device_class": "A",
        "gateway_id": "gateway-01",
        "rssi_dbm": -85,
        "snr_db": 8,
        "spreading_factor": 7,
        "frequency_hz": 868100000,
        "messages_today": 48,
        "count_date": "2026-11-03"
      }
    }
  }
}
```

### GPS field meanings

| Field inside `gps` | Contract / display behavior |
| --- | --- |
| `fix` | Required boolean: whether this observation reports a current fix |
| `latitude`, `longitude` | Optional numeric coordinates, −90…90 and −180…180 degrees |
| `fix_received_at` | Optional UTC time of the successful fix; supply it when reporting an old position |
| `satellites` | Optional nonnegative integer count |
| `accuracy_m` | Optional nonnegative accuracy estimate in metres |

For a current location the view requires valid coordinates, `fix: true` and a fresh
fix time; it uses the uplink time if `fix_received_at` is omitted. Freshness uses
`message_timeout_seconds` from `site.json` (180 seconds by default). With `fix:
false`, include the last known coordinates and their actual successful-fix time if
you want them displayed. The UI does not merge missing coordinate fields from an
older GPS object. Without coordinates it shows no known location. The map is an
illustration, not a mapping service. Satellites and accuracy remain in the stored
payload; they do not add extra cards to the current V2 view.

### LoRaWAN field meanings

| Field inside `lorawan` | Contract / display behavior |
| --- | --- |
| `configured` | Required boolean; false explicitly selects the mock "Not configured" status |
| `dev_eui` | Optional string device identifier shown in details |
| `network` | Optional string network name, such as `TTN` |
| `device_class` | Optional string class, such as `A` |
| `gateway_id` | Optional string identifying the reporting gateway |
| `rssi_dbm` | Optional numeric received signal strength in dBm |
| `snr_db` | Optional numeric signal-to-noise ratio in dB |
| `spreading_factor` | Optional integer from 5 to 12 |
| `frequency_hz` | Optional nonnegative frequency in hertz; displayed in MHz |
| `messages_today` | Optional nonnegative integer mock network count |
| `count_date` | Optional UTC date `YYYY-MM-DD` to which that count applies |

The daily count is shown only when `count_date` matches the current UTC date; it is
not counted from MQTT arrivals or stored rows. Signal quality uses the example
RSSI heuristic documented in the root README. "Receiving messages" and "No recent
messages" depend on the selected device's latest uplink age; the MQTT/SSE/database
connection indicators describe separate services. Frame counter and last decoded
payload in details refer to the latest observation across that device's FPorts.
A counter gap does not establish RF loss.

## Generic, environment and energy variants

These five messages preserve the earlier examples. FPort meanings belong to the
selected profile. In particular, `energy` uses **FPort 10 for electrical readings**,
while `environment`, `generic` and `solar` use FPort 10 for temperature/humidity.
Do not select the electrical interpretation from FPort alone.

### Generic FPort 10

Generic temperature/humidity observation; the configured generic profile supplies its meaning.

Topic: `v3/mock-lab@ttn/devices/node-01/up`.
Fixture: [`fport-10.json`](fport-10.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "node-01"
  },
  "received_at": "2026-11-02T12:00:00.000Z",
  "uplink_message": {
    "session_key_id": "mock-session-01",
    "f_cnt": 42,
    "f_port": 10,
    "decoded_payload": {
      "schema_version": 1,
      "temperature_c": 21.7,
      "humidity_pct": 48.2
    }
  }
}
```

### Generic FPort 20

Generic electrical observation.

Topic: `v3/mock-lab@ttn/devices/node-01/up`.
Fixture: [`fport-20.json`](fport-20.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "node-01"
  },
  "received_at": "2026-11-02T12:00:01.000Z",
  "uplink_message": {
    "session_key_id": "mock-session-01",
    "f_cnt": 43,
    "f_port": 20,
    "decoded_payload": {
      "schema_version": 1,
      "voltage_v": 12.4,
      "current_a": 0.42,
      "power_w": 5.208
    }
  }
}
```

### Generic FPort 30

Generic status without battery_pct. The V2 charge percentage remains unknown; battery_v is not a percentage.

Topic: `v3/mock-lab@ttn/devices/node-01/up`.
Fixture: [`fport-30.json`](fport-30.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "node-01"
  },
  "received_at": "2026-11-02T12:00:02.000Z",
  "uplink_message": {
    "session_key_id": "mock-session-01",
    "f_cnt": 44,
    "f_port": 30,
    "decoded_payload": {
      "schema_version": 1,
      "battery_v": 3.82,
      "uptime_s": 3600,
      "status": "ok"
    }
  }
}
```

### Environment profile, FPort 10

Temperature/humidity with device_type selecting the environment profile.

Topic: `v3/mock-lab@ttn/devices/climate-01/up`.
Fixture: [`climate-device.json`](climate-device.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "climate-01"
  },
  "received_at": "2026-11-02T12:00:04.000Z",
  "uplink_message": {
    "session_key_id": "mock-session-climate",
    "f_cnt": 1,
    "f_port": 10,
    "decoded_payload": {
      "schema_version": 1,
      "device_type": "environment",
      "temperature_c": 18.4,
      "humidity_pct": 55.0
    }
  }
}
```

### Energy profile, FPort 10

Electrical measurements with device_type selecting the energy profile.

Topic: `v3/mock-lab@ttn/devices/energy-01/up`.
Fixture: [`energy-device.json`](energy-device.json).

```json
{
  "end_device_ids": {
    "application_ids": {
      "application_id": "mock-lab"
    },
    "device_id": "energy-01"
  },
  "received_at": "2026-11-02T12:00:05.000Z",
  "uplink_message": {
    "session_key_id": "mock-session-energy",
    "f_cnt": 1,
    "f_port": 10,
    "decoded_payload": {
      "schema_version": 1,
      "device_type": "energy",
      "voltage_v": 24.2,
      "current_a": 0.6,
      "power_w": 14.52
    }
  }
}
```

## Publish a fixture and check receipt

From the repository root, the following publishes the solar electrical fixture to
the simulated TTN broker using the installed MQTTCLI:

```sh
mqttcli --config-file /dev/null \
  in-mqtt --disabled=false remote --host 127.0.0.1 --port 18883 \
  pub --topic 'v3/mock-lab@ttn/devices/solar-01/up' \
      --message "$(cat mock/solar-20.json)" \
  socket --reconnect=false
```

Use the correct device topic from the table for other fixtures. For a direct test
of the local broker/store/dashboard, use the local broker's port instead; that
bypasses the upstream bridge. Do not treat that as a test of TTN-to-local forwarding.
On real TTN, devices produce uplinks and the existing bridge receives them; the
command above is for the local mock broker.

The checked-in examples have fixed historical timestamps and counters. Before
publishing a **new live test observation**, use a disposable edited copy with a
current UTC millisecond `received_at` and a new `f_cnt`. For GPS update the actual
fix timestamp independently; for a daily network count set the applicable
`count_date`. Republishing unchanged fixtures tests duplicate/replay behavior and
can show stale readings or gaps outside the chart window. The dashboard service
itself does not start a mock publisher.

Check `/api/events` on the dashboard's HTTP listener: the first `snapshot` contains
stored observations; a matching new MQTT message produces `uplink` with `stored:
false`, followed by `stored` once the independent MQTTStore insert is visible.
`/api/history` supplies the latest 200 persisted rows. A browser refresh presents
stored state again. Failure to obtain storage confirmation does not mean the live
MQTT observation was never received. Failed MQTTStore inserts require explicit
redelivery after recovery.

## Use another application, device type or final protocol

Keep these configuration boundaries consistent:

1. Set the upstream bridge topic and, for real TTN, its application username and
   cluster/credentials in a protected `config/bridge.local.json`.
2. Set MQTTStore's local subscription and the selected projection's `topic` to
   that application's uplink filter. Keep the JSON Pointer mappings consistent
   with the published envelope. Restart MQTTStore for projection changes.
3. Set the dashboard settings `topic` to the same local filter and restart it.
4. Use the envelope's actual application ID in `site.json` device assignments.
   The example JSON Schema's application constant is `mock-lab`; change it if you
   use that schema to validate another application's messages.
5. Change per-profile `roles` and `ports` in `web/public/site.json` for changed
   FPorts or measurement fields. Keep automatic device_type metadata consistent
   on every uplink, or use an explicit device assignment.
6. For a changed envelope/projection schema, change MQTTStore's mapping, SQL schema
   as required, and the external `web/model.json` live/read mappings together.
   Restart affected services. The C++ binary contains no device-specific decoder.

The profile label/unit metadata and visual role bindings are distinct: merely
adding a port label does not bind that field to a dashboard card. All website and
protocol adapters remain externally replaceable. See the
[Pi deployment guide](../deploy/README.md) for paths, service configuration and
which changes require a restart. This reference does not define a binary LoRaWAN
codec or automatically transform TTN's native radio metadata into the mock object.
