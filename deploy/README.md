# Deploy MQTTDashboard on a Raspberry Pi

This guide deploys only MQTTDashboard and its external website. SNode.C and
MQTTSuite are already installed on the Pi. Use their installed CMake packages and
binaries; no MQTTSuite source checkout is needed. The local MQTT broker, MQTTBridge,
MQTTStore and MariaDB are independent services and remain managed separately.

The dashboard reads MariaDB and subscribes to the local broker. MQTTStore remains
the only telemetry writer. Building or restarting the dashboard does not provision
the database, start the broker or change MQTTStore's projection configuration.

## 1. Clone and build on the Pi

Run as the Linux user who will run the dashboard:

```sh
cd "$HOME"
git clone --recurse-submodules https://github.com/SNodeC/mqttdashboard.git
cd mqttdashboard
git switch main
git submodule update --init checkouts/inja
cmake -S . -B build/codex/release \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
cmake --build build/codex/release --parallel 2
```

Build natively on the Pi; do not copy the development machine's executable.
The dashboard requires a C++20 compiler, CMake 3.20+, nlohmann JSON 3.8+ development
headers and the installed SNode.C development package, including its MariaDB
component. If SNode.C was installed in a custom prefix, add
`-DCMAKE_PREFIX_PATH=/your/installed/prefix` to configuration. Inja is the pinned
repository submodule and needs no separate installation. Node.js, a JavaScript
package manager and Python are not needed to build or run this deployment.

There is no CMake install target. In this deployment the checkout is the application
directory: it supplies the executable, external `web/` directory and local config.
Keep it in place while the service is running. Use a different checkout path only
if you also update the service's paths.

## 2. Check the existing database and MQTTStore projection

The [MQTT topic and JSON reference](../mock/README.md) describes every expected
message, all receiving filters and the complete provisional payload contract.
Use it when configuring the existing bridge, MQTTStore or device decoder.

Skip schema creation if this dashboard schema is already provisioned. Otherwise,
as the MariaDB administrator, from the checkout run:

```sh
sudo mariadb < sql/schema.sql
```

This creates `ttn_dashboard.ttn_uplinks` and the example storage/reader accounts.
It does not drop existing tables or reset an existing account's password.
The supplied passwords are mock values. Set deployment passwords for these accounts
in MariaDB and enter the matching values in each service's protected local config.
The dashboard uses `dashboard_reader`, which has SELECT permission only.

The existing MQTTStore service must use the matching subscription and projection:

- For the example, subscribe to `v3/mock-lab@ttn/devices/+/up` and select the
  checkout's `config/projections.json` as its `projection-file`.
- Set an absolute projection-file path when MQTTStore has another working directory.
- For another TTN application, copy the projection to
  `config/projections.local.json`, replace its `topic`, and select that file in
  MQTTStore. Match the broker/bridge subscription, MQTTStore subscription, projection
  topic and dashboard topic. Restart MQTTStore after changing its definition.
- Keep the supplied table/column contract or supply a corresponding `web/model.json`.
  A dashboard-only update does not require a new table migration for V2: GPS and
  radio observations remain JSON fields in the existing projection.

Use the actual database socket path. It can be inspected with:

```sh
sudo mariadb --batch --skip-column-names -e "SHOW VARIABLES LIKE 'socket';"
```

This section configures the integration with the already installed MQTTStore;
it does not install or create a new service for it.

## 3. Create the dashboard's local configuration

From the checkout:

```sh
cp config/dashboard.json config/dashboard.local.json
cp config/mqttclient.conf config/mqttclient.local.conf
chmod 600 config/dashboard.local.json config/mqttclient.local.conf
```

Edit `config/dashboard.local.json`. For the example deployment:

```json
{
  "web_root": "../web",
  "topic": "v3/mock-lab@ttn/devices/+/up",
  "client_id": "raspi-dashboard",
  "mqtt_username": "",
  "mqtt_password": "",
  "reconcile_seconds": 3,
  "database": {
    "host": "localhost",
    "port": 3306,
    "socket": "/run/mysqld/mysqld.sock",
    "name": "ttn_dashboard",
    "username": "dashboard_reader",
    "password": "REPLACE_WITH_YOUR_READER_PASSWORD"
  }
}
```

Use your actual topic, socket and credentials. The MQTT client ID must be unique
among clients on the broker. Empty MQTT credentials are suitable only when the
existing local broker permits them. For a TCP database connection, use its host
and port and set `socket` to an empty string.

`web_root` resolves relative to this settings JSON, so `../web` selects this
checkout's website. It may instead be an absolute path to a separately deployed
complete website. Database and MQTT credentials belong in the settings file,
never in the public `site.json`.

In `config/mqttclient.local.conf`, change the existing entries to:

```ini
settings = "config/dashboard.local.json"

[web.local]
host = "127.0.0.1"
port = 18080

[web.connection]
read-timeout = 0
write-timeout = 30
maximum-write-queue-bytes = 1048576

[mqtt.remote]
host = "127.0.0.1"
port = 1883
```

Use the host and port of your existing local broker. Port 18080 avoids the commonly
used 8080 port; check it is free on your Pi. Keep `read-timeout = 0` for the long-lived
SSE connection. These `*.local.*` config files are ignored by Git.

## 4. Run and check it in the foreground

```sh
build/codex/release/mqttdashboard \
  --config-file config/mqttclient.local.conf \
  --settings config/dashboard.local.json
```

From a second terminal on the Pi:

```sh
curl --fail http://127.0.0.1:18080/api/status
curl --fail http://127.0.0.1:18080/api/history
curl --no-buffer --max-time 15 -H 'Accept: text/event-stream' \
  http://127.0.0.1:18080/api/events
```

The status should show MQTT and database availability. The events stream starts
with `snapshot`; a new device message produces `uplink` and then `stored` after
MQTTStore projects it. The last curl command intentionally times out after 15
seconds. An empty snapshot is normal before the first matching uplink.

To view it from your development computer without changing the listener, open an
SSH tunnel in a terminal on that computer:

```sh
ssh -N -L 18081:127.0.0.1:18080 YOUR_PI_USER@YOUR_PI_HOST
```

Then open **http://127.0.0.1:18081/** on that computer. The different local port also
allows the development demo to continue using port 18080.

For direct access on your trusted LAN, change `[web.local] host` to `0.0.0.0`, restart
the dashboard and browse to `http://YOUR_PI_IP:18080/`. The dashboard has no HTTP
login or TLS. The owner's accepted upstream static-file containment limitation
also applies here; directory separation does not protect process-readable files.

Stop the foreground dashboard with Ctrl+C before starting its systemd service.
Do not stop the independently managed broker, bridge or MQTTStore.

## 5. Start the dashboard automatically with systemd

Run the following from the checkout as the intended service user. It writes only
the dashboard unit and uses absolute paths from your current checkout:

```sh
dashboard_root="$(pwd -P)"
dashboard_user="$(id -un)"
sudo tee /etc/systemd/system/mqttdashboard.service > /dev/null <<EOF_UNIT
[Unit]
Description=MQTTDashboard web and SSE service
Wants=network-online.target
After=network-online.target mariadb.service

[Service]
Type=simple
User=${dashboard_user}
WorkingDirectory=${dashboard_root}
ExecStart="${dashboard_root}/build/codex/release/mqttdashboard" --config-file "${dashboard_root}/config/mqttclient.local.conf" --settings "${dashboard_root}/config/dashboard.local.json"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF_UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now mqttdashboard.service
sudo systemctl status mqttdashboard.service --no-pager
```

The unit assumes MariaDB's existing unit is called `mariadb.service`; adjust that
ordering entry if yours differs or the database is remote. It does not start or
configure the broker/store services. The existing SNode.C connection handling
retries unavailable MQTT/database connections. The service user needs read access
to the selected website and config, and access to the configured database socket.

Inspect dashboard logs and repeat the HTTP checks after startup:

```sh
journalctl -u mqttdashboard.service -n 100 --no-pager
curl --fail http://127.0.0.1:18080/api/status
```

The deployed website is the repository's V2 mock-format example. Devices appear
from persisted or live observations, not merely from entries in `site.json`.
For a new application, adjust `web/public/site.json` device assignments or include
`device_type: "solar"` in matching decoded payloads. Real decoder field names and
FPorts must match that profile's `roles`; otherwise the corresponding values show
dashes. The provisional payload contract and five solar fixtures are documented in
the [root README](../README.md#figma-v2-example). No mock publisher is started by
the systemd unit.

## 6. Change the pages or update the deployed dashboard

Edit templates, CSS, browser JavaScript, icons and profile presentation in the
selected `web/` directory. Refresh the browser to see these edits; no recompilation
is needed. Keep deployment-specific website changes in your separately supplied
web directory if you want to update the checkout without local source conflicts.
Restart the dashboard when changing routes, template assignments, `web_root`,
settings or `model.json`. MQTTStore projection changes require its separate restart
and any explicitly required schema migration.

To update an unmodified checkout on the Pi:

```sh
cd "$HOME/mqttdashboard"
git status --short
git pull --ff-only origin main
git submodule update --init checkouts/inja
cmake -S . -B build/codex/release \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
cmake --build build/codex/release --parallel 2
sudo systemctl restart mqttdashboard.service
sudo systemctl status mqttdashboard.service --no-pager
curl --fail http://127.0.0.1:18080/api/status
```

Resolve any local source/website edits before pulling; do not reset or discard
them. The ignored local configs are preserved. Confirm a fresh page load shows
stored observations, then publish a matching uplink through the existing pipeline
and confirm the page changes without reloading. Changes remain unconfirmed until
MQTTStore stores them. Failed MQTTStore inserts still require explicit redelivery;
restarting the dashboard does not replay them.
