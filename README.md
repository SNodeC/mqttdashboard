# MQTTDashboard

A reusable MQTT dashboard host built with SNode.C and MQTTSuite, with an externally supplied website and a LoRaWAN example.

Four independent SNode.C/MQTTSuite applications form the deployment: `mqttbridge` forwards TTN uplinks to a local `mqttbroker`; unmodified `mqttstore` persists them; `mqttdashboard` is the extended MQTT client providing Express routes, Inja pages, read-only MariaDB access and live SSE. The complete website is supplied externally, including the overview, navigation, device dashboards, styles and browser JavaScript.

The included deployment uses a second local MQTTBroker to simulate TTN. Device identities, timestamps, payloads and database passwords are mock development values. The default configuration does not contact TTN.

The owner explicitly accepts the installed SNode.C 2.1.0 static middleware's lack of root containment. For example, `/assets/%2e%2e/model.json` exposes a file outside `public/`; traversal and escaping symlinks can expose other files readable by the server process, including credentials. This remains a known security limitation, not a deployment gate for this project. SNode.C is unchanged, and no application-level path filter is introduced. The containment test remains executable as an expected failure documenting this accepted limitation.

## Build

Use an installed SNode.C 2.1 development package, MQTTSuite including MQTTStore, MariaDB Server/client, nlohmann JSON 3.8+, a C++20 compiler and CMake 3.20+. Inja is an explicitly declared upstream Git submodule at `checkouts/inja`, pinned to v3.5.0 (`7d1b4600b68595085a949743331c2e5673f511ea`). It is header-only and consumed through its public include directory; the build does not invoke its packaging/generation scripts or install it. No separate MQTTSuite source checkout or personal include path is used.

Clone the repository and its pinned Inja dependency:

```sh
git clone --recurse-submodules https://github.com/SNodeC/mqttdashboard.git
cd mqttdashboard
```

Then build from the repository directory:

```sh
git submodule update --init checkouts/inja
cmake -S . -B build/codex/debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build/codex/debug
```

Use `CMAKE_PREFIX_PATH` for an installed SNode.C package in a nonstandard prefix. The validated local configuration uses Clang 21.1.8, SNode.C 2.1.0 and MariaDB 11.8. The application follows MQTTCli's MQTT callbacks, SNode.C Express and asynchronous MariaDB interfaces, and MQTTBroker's SSE lifetime/cleanup techniques. Neither page rendering nor the build rewrites application source or deployment templates.

`cmake --build build/codex/debug --target format` applies the committed canonical formatting baseline; `format-check` checks application C++. `-DDASHBOARD_CLANG_TIDY=ON` enables the committed analysis baseline. Dependency and build trees are excluded from formatting.

## Start the mock deployment

First provision the intended development MariaDB server as its administrator:

```sh
mariadb < sql/schema.sql
```

This explicitly creates the schema, projection table and mock storage/reader accounts. MQTTStore creates its raw `mqtt_messages` table. The dashboard account has SELECT permission only. Adjust database connection details in `config/dashboard.json` and `config/mqttstore.conf`. With a Unix socket, use host `localhost` and the desired socket path; with TCP, use the server address and an empty socket. These are MariaDB Connector/C semantics. Replace the mock passwords in protected `config/*.local.*` files before deployment; these paths are ignored by Git.

Run each command in a separate terminal, from this directory:

```sh
# Simulated TTN upstream, port 18883
mqttbroker --config-file config/broker.conf in-mqtt local --port 18883
```

```sh
# Local distribution broker, port 1883
mqttbroker --config-file config/broker.conf
```

```sh
mqttbridge --config-file config/mqttbridge.conf
```

```sh
mqttstore --config-file config/mqttstore.conf
```

```sh
build/codex/debug/mqttdashboard --config-file config/mqttclient.conf
```

Listeners are loopback-only; MQTTBridge's administration listeners are disabled. Its upstream connection subscribes to `v3/mock-lab@ttn/devices/+/up`, and its local connection has no subscriptions. Existing MQTTBridge forwarding therefore preserves topics and payloads in one direction. Nonstandard bridge loop-prevention flags are disabled.

Wait for subscriptions, open http://127.0.0.1:8080/ and publish a fixture to the simulated TTN broker:

```sh
mqttcli --config-file /dev/null \
  in-mqtt --disabled=false remote --host 127.0.0.1 --port 18883 \
  pub --topic 'v3/mock-lab@ttn/devices/node-01/up' \
      --message "$(cat mock/fport-10.json)" \
  socket --reconnect=false
```

Repeat with `mock/fport-20.json` and `mock/fport-30.json`. For `mock/climate-device.json`, publish to `v3/mock-lab@ttn/devices/climate-01/up`; for `mock/energy-device.json`, use `v3/mock-lab@ttn/devices/energy-01/up`. Those two device types deliberately use FPort 10 for different measurements. Increment the counter and timestamp to simulate another uplink. Re-delivery of the same identity is recorded in raw storage; the projection's unique key rejects duplicate rows, which MQTTStore can log as a duplicate-key error.

## The replaceable web directory

`web_root` in the dashboard settings selects the whole site directory, relative to the settings JSON or as an absolute path. There is no built-in overview or device page. The supplied example is:

```text
web/
  model.json                       Operator-owned read/live data adapter
  templates/
    layout.html                    Inja layout and navigation
    overview.html                  Device directory and location pages
    device.html                    Shared device dashboard
    device-content.html            Device content include
    readings.html                  Shared readings/history partial
    devices/environment.html       Environment dashboard specialization
    devices/energy.html             Energy dashboard specialization
  public/
    site.json                      Routes, profiles, labels and navigation
    app.js                         Native EventSource and DOM presentation
    devices.js                     Discovery and device-profile presentation
    state.js                       One canonical observation collection
    style.css
```

The static mount at `/assets/` selects `public/`; templates and SQL adapter configuration live outside that directory. This directory separation provides no security boundary with the accepted middleware behavior described above. `site.json` is intentionally public and must contain no secrets. HTML, CSS and JavaScript require no bundling, transpilation, framework, CDN or package installation.

`public/site.json` owns the Express route definitions and template selection. The host registers them through the existing Express router; it does not implement a second route parser. For example:

```json
{
  "path": "/catalog/rooms/:room/devices/:device",
  "template": "catalog/device.html",
  "data": {"title": "Device details"}
}
```

Each template receives `site` (current public site configuration), `page` (that route's `data`), `params`, `query`, `path` and `records` (the stored snapshot). HTML autoescaping is enabled. Inja includes and single-level layout inheritance support shared content and page templates in nested directories. The supplied site avoids nested inheritance blocks, which corrupt output in the pinned Inja release; URL hierarchy depth is independent of template inheritance. Route parameters are captured before asynchronous database reads, because Express restores parameter scope when dispatch unwinds. If history is unavailable, the HTML shell still renders with an empty record list and the SSE connection reports database status independently.

Changing template, CSS, JavaScript, navigation labels or profile contents takes effect on the next page load. Changing the route definitions, route template assignment, selected site directory or `model.json` requires restarting the dashboard. Changing projection definitions requires restarting MQTTStore and supplying matching schema migrations. None of these deployment changes requires recompiling the dashboard binary.

To attach a different website, create its `templates/`, `public/site.json` and `model.json`, point a protected settings file's `web_root` at it, and start the same binary with `--settings <file>`. The replacement can have its own overview, paths, layout, assets and browser code. Optional projection and schema files can live alongside it and be selected through MQTTStore's configuration and explicit database provisioning; this placement does not provide static-file access protection.

## Overview, discovery and device profiles

The example overview derives devices from stored and incoming observations. New devices appear dynamically without creating HTML files. Configuring a device label alone does not create an observed device. Registered devices that have never transmitted would need an additional inventory source, which this implementation does not introduce.

Profiles in `public/site.json` define the device dashboard route, per-FPort labels and field units. Device assignments can provide a profile, friendly name and location. Otherwise each uplink's optional `values.device_type` selects a known profile; unknown types use the configured generic profile. Devices using automatic type selection should include that metadata in their uplinks. FPort meanings belong to a device profile, not to a global FPort registry.

The supplied hierarchy is:

| Route | Example page |
| --- | --- |
| `/` | All observed devices, with links to their dashboards |
| `/locations/:location` | Devices assigned to a location |
| `/devices/:application/:device` | Generic reusable device dashboard |
| `/environment/:application/:device` | Environment device dashboard |
| `/energy/:application/:device` | Energy device dashboard |

The browser derives directory entries and latest readings from one deduplicated message collection. Device identity includes application and device ID. Profile route parameters are URL-encoded. Device pages filter by both identifiers, while locations and FPort filters refine the example presentation. These filters are presentation, not access-control boundaries: the SSE API serves the configured observation feed. All markup, navigation and client behavior remain replaceable.

## External projections and the data adapter

`config/projections.json` uses unmodified MQTTStore topic filters and JSON Pointer mappings to populate the operator-created `ttn_uplinks` table. The database schema, raw/projection behavior and MQTT subscription remain independent of the web design. Projections may later target other tables without C++ changes: provide the corresponding read adapter in the selected web directory.

`model.json` defines three SQL queries and a `live` mapping from canonical record fields to JSON Pointers in an MQTT envelope. `snapshot_sql` supplies initial state and template records; `history_sql` supplies bounded history; `changes_sql` uses the Inja expression `{{ cursor }}` for incremental reads. `history_limit` describes the configured history bound. Queries are operator-owned, fixed configuration; HTTP parameters are never substituted into SQL. The dashboard database account remains read-only.

Every query returns two columns: an unsigned monotonic row ID and a JSON object with the same record shape as the live mapping:

```json
{
  "application_id": "mock-lab",
  "device_id": "climate-01",
  "session_id": "mock-session-climate",
  "frame_counter": 1,
  "fport": 10,
  "received_at": "2026-11-02T12:00:04.000Z",
  "values": {"schema_version": 1, "device_type": "environment", "temperature_c": 18.4, "humidity_pct": 55.0},
  "stored": true
}
```

The live adapter supplies the same fields through configured pointers; the host marks those arrivals `stored: false`. The host requires object-valued `values` and an application FPort in 1–223. Keep identity fields and value meanings consistent between the adapter and projections. The supplied mock contract is documented in `mock/uplink.schema.json`; it is not a binary LoRaWAN decoder. The default mock is scoped to one TTN application/tenant and uses UTC timestamps with three fractional digits for stable source-time ordering.

The snapshot query keeps the latest 200 inserted observations plus the latest per device/FPort, so old devices and infrequently transmitting FPorts remain discoverable. The changes query's row cursor assumes the configured unmodified MQTTStore instance is the sole writer using one database connection. An auto-increment ID is not a general commit-order guarantee across concurrent writers. A different projection scheme must provide an appropriate cursor and snapshot query.

MQTTStore does not validate incoming payloads against the supplied example JSON Schema. Its projection `required` option inserts NULL when a source is missing; SQL constraints enforce required projected fields. Raw storage preserves messages independently when its insert succeeds. Database migrations and replay are explicit administrative operations.

## HTTP and SSE contract

| Endpoint/event | Contract |
| --- | --- |
| `GET /api/events` | Requires `Accept: text/event-stream`; initial snapshot then live events |
| `snapshot` | `{ "records": [...] }`; `unavailable: true` on initial history failure |
| `uplink` | One canonical record, with `stored: false` |
| `stored` | `{ "records": [...] }` discovered persisted records |
| `status` | `mqtt`, `database` (history-read availability) and configured `mock_format` |
| `GET /api/history` | `{ "records": [...], "limit": ... }` from the configured history query |
| `GET /api/status` | Current observed MQTT/history status |

Receivers are registered before snapshot reads and buffer MQTT arrivals until the initial snapshot is delivered. Initial buffers are bounded at 1000 messages; exceeding that closes the receiver so it can reconnect with a new snapshot. The example connection configuration bounds socket write queues through SNode.C. Native EventSource reconnects obtain fresh snapshots; durable SSE replay is not claimed.

MQTT callbacks send immediate live events. An existing SNode.C timer discovers later database inserts and sends SSE keep-alives. The browser merges overlaps by application/device/session/counter/FPort identity. Confirmed stored content wins over an unconfirmed redelivery of the same identity. Connection state notifications own database connectivity; SQL result callbacks own history availability, including schema/query errors. No custom database reconnect mechanism is introduced.

Raw and projected inserts are independent. Unmodified MQTTStore does not replay inserts failed during a database outage or reconnect; explicit redelivery is still required. Live values remain marked unconfirmed until a matching stored record appears. TTN MQTT is QoS 0, so neither the local bridge nor dashboard can recover upstream messages never received.

## Connect real TTN later

Copy `config/bridge.example.json` to a protected `config/bridge.local.json`, supply the correct TTN cluster/application/API key and select that definition in a protected bridge configuration. The example uses TLS on 8883; configure certificate trust through SNode.C's TLS options and retain disabled bridge administration listeners. Update application topics consistently in the bridge, MQTTStore projection and dashboard subscription settings. MQTTStore and the dashboard continue to connect only to the local broker.

## Verification and accounting

```sh
cmake -S . -B build/codex/debug -DBUILD_TESTING=ON
cmake --build build/codex/debug
ctest --test-dir build/codex/debug --output-on-failure -j 3
```

Tests use the existing Python standard-library MariaDB fixture technique and Node's built-in test runner. They are development tools only; `BUILD_TESTING` defaults to OFF. Tests run real local brokers, MQTTBridge, unmodified MQTTStore, disposable socket-only MariaDB and the dashboard, with files under `/tmp/codex/build/ttn-dashboard/`. They do not access installed databases or real TTN.

Coverage includes snapshot/live handoff, writes discovered after arrival, duplicate identities, initial database connection failure, SQL/history failure, database restart and explicit redelivery, read-only grants, editable templates/assets, nested routes/inheritance, escaping, a completely independent replacement site and an alternate projection read model. Browser-state tests cover discovery, device types sharing FPorts, generic fallback, route encoding, filtering, session resets and bounded history. Application C++ growth is measured against the 407-line starting point; its approved ceiling is 507 lines. The unchanged Inja submodule is accounted for separately as the explicitly approved dependency.

Current local verification: 13 integration cases pass; the static-root confinement case is an expected failure documenting the owner's acceptance of the installed SNode.C 2.1.0 behavior. Encoded and literal traversal and an escaping symlink were separately confirmed to expose files outside the static root. All eight browser-state cases, JavaScript syntax and C++ formatting pass. Browser interaction also confirmed that an unconfigured device appears live in the overview and opens its type-specific dashboard. The reusable-host change adds 52 application C++ lines (407 to 459), 402 web-package lines (563 to 965), and separately 151 test lines (452 to 603). Website growth supplies the externally replaceable presentation and device profiles; C++ growth supplies external template/routes/read-model handling and correct asynchronous connection/request ownership.
