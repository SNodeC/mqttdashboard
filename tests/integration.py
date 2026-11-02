"""Public-boundary tests using real SNode.C/MQTTSuite binaries and disposable MariaDB.

Uses Python's standard library only, following SNode.C's MariaDB fixture pattern.
No installed database, existing broker or TTN account is accessed.
"""
import argparse
import copy
import http.client
import json
import os
from pathlib import Path
import pwd
import queue
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
BUILD_ROOT = Path("/tmp/codex/build/ttn-dashboard")
BINARY = None


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return port


def wait_until(check, description, timeout=15):
    deadline = time.monotonic() + timeout
    ready = False
    while not ready and time.monotonic() < deadline:
        try:
            ready = bool(check())
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        if not ready:
            time.sleep(0.08)
    if not ready:
        raise AssertionError("Timed out waiting for " + description)


class Events:
    def __init__(self, port):
        self.connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
        self.connection.request("GET", "/api/events", headers={"Accept": "text/event-stream"})
        self.socket = self.connection.sock
        self.response = self.connection.getresponse()
        if self.response.status != 200:
            raise AssertionError("SSE request failed")
        self.events = queue.Queue()
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def read(self):
        try:
            name, data = "", ""
            active = True
            while active:
                line = self.response.readline()
                active = bool(line)
                text = line.decode().strip()
                if text.startswith("event:"):
                    name = text[6:].strip()
                elif text.startswith("data:"):
                    data = text[5:].strip()
                elif not text and data:
                    self.events.put((name, json.loads(data)))
                    name, data = "", ""
        except (OSError, ValueError, http.client.HTTPException):
            pass

    def get(self, name, predicate=lambda value: True, timeout=12):
        deadline = time.monotonic() + timeout
        found = None
        while found is None and time.monotonic() < deadline:
            try:
                event, data = self.events.get(timeout=0.2)
                if event == name and predicate(data):
                    found = data
            except queue.Empty:
                pass
        if found is None:
            raise AssertionError("Missing SSE event: " + name)
        return found

    def close(self):
        if self.socket.fileno() >= 0:
            self.socket.shutdown(socket.SHUT_RDWR)
        self.thread.join(timeout=2)
        self.response.close()
        self.connection.close()


class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        BUILD_ROOT.mkdir(parents=True, exist_ok=True)
        cls.directory = tempfile.TemporaryDirectory(prefix="integration-", dir=BUILD_ROOT)
        cls.work = Path(cls.directory.name)
        cls.processes = []
        cls.logs = []
        cls.addClassCleanup(cls.cleanup)
        cls.user = pwd.getpwuid(os.getuid()).pw_name
        cls.endpoint = cls.work / "db.sock"
        cls.upstream_port, cls.local_port, cls.web_port = free_port(), free_port(), free_port()
        cls.env = dict(os.environ, TMPDIR=str(cls.work))
        init_log = (cls.work / "initialize.log").open("w")
        cls.logs.append(init_log)
        subprocess.run(["mariadb-install-db", "--no-defaults", "--datadir=" + str(cls.work / "data"),
                        "--tmpdir=" + str(cls.work), "--auth-root-authentication-method=socket",
                        "--auth-root-socket-user=" + cls.user, "--skip-test-db"],
                       stdout=init_log, stderr=subprocess.STDOUT, check=True, timeout=40, env=cls.env)
        server = shutil.which("mariadbd") or "/usr/sbin/mariadbd"
        cls.start("database", [server, "--no-defaults", "--user=" + cls.user,
                  "--datadir=" + str(cls.work / "data"), "--tmpdir=" + str(cls.work),
                  "--socket=" + str(cls.endpoint), "--pid-file=" + str(cls.work / "db.pid"),
                  "--skip-networking", "--innodb-buffer-pool-size=64M", "--innodb-log-file-size=16M"])
        wait_until(lambda: cls.sql("SELECT 1").strip() == "1", "disposable MariaDB")
        cls.sql((ROOT / "sql/schema.sql").read_text())
        cls.broker("upstream", cls.upstream_port)
        cls.broker("local", cls.local_port)
        bridge = json.loads((ROOT / "config/bridge.mock.json").read_text())
        endpoints = bridge["bridges"][0]["brokers"]
        endpoints[0]["network"]["in"]["port"] = cls.upstream_port
        endpoints[1]["network"]["in"]["port"] = cls.local_port
        definition = cls.work / "bridge.json"
        definition.write_text(json.dumps(bridge))
        cls.start("bridge", ["mqttbridge", "--config-file", str(ROOT / "config/mqttbridge.conf"), "--log-level", "2",
                  "bridge", "--definition", str(definition)])
        cls.store = cls.start_store()
        cls.fixtures = [json.loads((ROOT / f"mock/fport-{port}.json").read_text()) for port in [10, 20, 30]]
        cls.fixtures.extend(json.loads((ROOT / f"mock/{kind}-device.json").read_text()) for kind in ["climate", "energy"])
        # Both bridge endpoints must be online before publishing the first mock message.
        wait_until(lambda: cls.bridge_ready(), "bridge forwarding and MQTTStore projection")
        for message in cls.fixtures:
            cls.publish(message)
        wait_until(lambda: cls.count() >= len(cls.fixtures), "FPort and device-type projections")
        cls.settings = json.loads((ROOT / "config/dashboard.json").read_text())
        cls.web_root = cls.work / "web"
        shutil.copytree(ROOT / "web", cls.web_root)
        cls.settings["web_root"] = str(cls.web_root)
        cls.settings["reconcile_seconds"] = 1
        cls.settings["database"]["socket"] = str(cls.endpoint)
        cls.settings_path = cls.work / "dashboard.json"
        cls.settings_path.write_text(json.dumps(cls.settings))
        cls.dashboard = cls.start_dashboard()
        wait_until(lambda: cls.http("/api/status")[0] == 200, "dashboard HTTP")

    @classmethod
    def start(cls, name, command):
        log = (cls.work / (name + ".log")).open("a")
        cls.logs.append(log)
        environment = dict(cls.env, XDG_CONFIG_HOME=str(cls.work / name / "config"),
                           XDG_STATE_HOME=str(cls.work / name / "state"),
                           XDG_DATA_HOME=str(cls.work / name / "data"),
                           XDG_RUNTIME_DIR=str(cls.work / name / "run"))
        Path(environment["XDG_RUNTIME_DIR"]).mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(command, cwd=cls.work, env=environment,
                                   stdout=log, stderr=subprocess.STDOUT)
        cls.processes.append(process)
        return process

    @classmethod
    def broker(cls, name, port):
        command = ["mqttbroker", "--config-file", str(ROOT / "config/broker.conf"), "--log-level", "2",
                   "in-mqtt", "local", "--host", "127.0.0.1", "--port", str(port)]
        cls.start(name, command)

    @classmethod
    def start_store(cls):
        return cls.start("store", ["mqttstore", "--config-file", str(ROOT / "config/mqttstore.conf"), "--log-level", "2",
                         "in-mqtt", "--disabled=false", "remote", "--host", "127.0.0.1",
                         "--port", str(cls.local_port), "session", "--client-id", "test-store",
                         "sub", "--topic", "v3/mock-lab@ttn/devices/+/up", "db",
                         "--socket", str(cls.endpoint), "--database", "ttn_dashboard",
                         "--username", "dashboard_store", "--password", "mock-store-password",
                         "storage", "--auto-create-raw-table", "--projection-file", str(ROOT / "config/projections.json")])

    @classmethod
    def start_dashboard(cls):
        return cls.start("dashboard", [str(BINARY), "--config-file", str(ROOT / "config/mqttclient.conf"), "--log-level", "2",
                         "--settings", str(cls.settings_path), "web", "local", "--port", str(cls.web_port),
                         "mqtt", "remote", "--host", "127.0.0.1", "--port", str(cls.local_port)])

    @classmethod
    def sql(cls, statement):
        result = subprocess.run(["mariadb", "--no-defaults", "--socket=" + str(cls.endpoint),
                                 "--user=" + cls.user, "--batch", "--skip-column-names"],
                                input=statement, text=True, capture_output=True, check=True, timeout=10)
        return result.stdout

    @classmethod
    def count(cls):
        return int(cls.sql("SELECT COUNT(*) FROM ttn_dashboard.ttn_uplinks"))

    @classmethod
    def publish(cls, message, port=None):
        subprocess.run(["mqttcli", "--config-file", "/dev/null", "--log-level", "2",
                        "in-mqtt", "--disabled=false", "remote", "--host", "127.0.0.1",
                        "--port", str(port or cls.upstream_port), "pub", "--topic",
                        "v3/mock-lab@ttn/devices/" + message["end_device_ids"]["device_id"] + "/up",
                        "--message", json.dumps(message), "socket", "--reconnect=false"],
                       check=True, capture_output=True, timeout=10, env=cls.env)

    @classmethod
    def bridge_ready(cls):
        message = json.loads((ROOT / "mock/fport-10.json").read_text())
        cls.publish(message)
        return cls.count() > 0

    @classmethod
    def http(cls, path, port=None):
        with urllib.request.urlopen(f"http://127.0.0.1:{port or cls.web_port}{path}", timeout=5) as response:
            result = response.status, response.read(), response.headers
        return result

    @classmethod
    def cleanup(cls):
        for process in reversed(cls.processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for log in cls.logs:
            log.close()
        # Print only local mock logs if a process failed unexpectedly.
        for path in cls.work.glob("*.log"):
            content = path.read_text(errors="replace")
            if content and path.name not in ["initialize.log", "database.log"]:
                print(path.name + ":\n" + content[-4000:])
        cls.directory.cleanup()

    def events(self, port=None):
        events = Events(port or self.web_port)
        self.addCleanup(events.close)
        return events

    def message(self, count, device="node-01"):
        message = copy.deepcopy(self.fixtures[0])
        message["uplink_message"]["f_cnt"] = count
        message["end_device_ids"]["device_id"] = device
        message["received_at"] = "2026-11-02T12:10:00.000Z"
        return message

    def test_initial_snapshot_contains_stored_fports_and_raw_payload(self):
        snapshot = self.events().get("snapshot")
        self.assertTrue({10, 20, 30}.issubset({row["fport"] for row in snapshot["records"]}))
        environment = next(row for row in snapshot["records"] if row["frame_counter"] == 42)
        self.assertEqual(environment["values"]["temperature_c"], 21.7)
        self.assertTrue(environment["stored"])
        self.assertGreater(int(self.sql("SELECT COUNT(*) FROM ttn_dashboard.mqtt_messages")), 0)

    def test_live_sse_then_database_confirmation_and_duplicate(self):
        events = self.events()
        events.get("snapshot")
        message = self.message(1001)
        self.publish(message)
        live = events.get("uplink", lambda row: row["frame_counter"] == 1001)
        self.assertFalse(live["stored"])
        confirmed = events.get("stored", lambda batch: any(row["frame_counter"] == 1001 for row in batch["records"]))
        self.assertTrue(next(row for row in confirmed["records"] if row["frame_counter"] == 1001)["stored"])
        self.publish(message)
        self.assertEqual(int(self.sql("SELECT COUNT(*) FROM ttn_dashboard.ttn_uplinks WHERE frame_counter=1001")), 1)

    def test_local_messages_do_not_forward_back_to_upstream(self):
        # A second store on the upstream would add complexity; observe the upstream directly.
        listener = self.start("upstream-observer", ["mqttcli", "--config-file", "/dev/null", "--log-level", "4",
                              "in-mqtt", "--disabled=false", "remote", "--host", "127.0.0.1",
                              "--port", str(self.upstream_port), "sub", "--topic", "v3/mock-lab@ttn/devices/+/up"])
        log_path = self.work / "upstream-observer.log"
        wait_until(lambda: "  r: 0" in log_path.read_text(), "upstream observer subscription")
        self.publish(self.message(1008))
        wait_until(lambda: "1008" in log_path.read_text(), "positive upstream observation")
        self.publish(self.message(1002), self.local_port)
        wait_until(lambda: int(self.sql("SELECT COUNT(*) FROM ttn_dashboard.ttn_uplinks WHERE frame_counter=1002")) == 1,
                   "locally published projection")
        time.sleep(0.3)
        listener.terminate()
        listener.wait(timeout=5)
        self.assertNotIn('1002', log_path.read_text())

    def test_editable_web_files_and_history_api(self):
        code, html, headers = self.http("/")
        self.assertEqual(code, 200)
        self.assertIn(b"Fieldnotes", html)
        self.assertEqual(headers["Cache-Control"], "no-store")
        for path, content in [("/assets/style.css", b".measurements"), ("/assets/app.js", b"EventSource"), ("/assets/state.js", b"function merge")]:
            self.assertIn(content, self.http(path)[1])
        history = json.loads(self.http("/api/history")[1])
        self.assertEqual(history["limit"], 200)
        self.assertGreaterEqual(len(history["records"]), 3)
        page = self.web_root / "templates/overview.html"
        original = page.read_text()
        try:
            page.write_text(original.replace("Observed devices", "Deployment edit is visible."))
            self.assertIn(b"Deployment edit is visible.", self.http("/")[1])
        finally:
            page.write_text(original)

    def test_external_routes_nested_inheritance_and_escaped_parameters(self):
        for path, text in [('/devices/mock-lab/node-01', b'Device dashboard'),
                           ('/environment/mock-lab/climate-01', b'Environment dashboard: temperature'),
                           ('/energy/mock-lab/energy-01', b'Energy dashboard: electrical'),
                           ('/locations/north-lab', b'north-lab')]:
            code, body, headers = self.http(path)
            self.assertEqual(code, 200)
            self.assertIn(text, body)
            self.assertNotIn(b'{%', body)
            self.assertEqual(headers['Cache-Control'], 'no-store')
        body = self.http('/devices/mock-lab/%3Cscript%3Ealert%281%29%3C%2Fscript%3E')[1]
        self.assertIn(b'&lt;script&gt;', body)
        self.assertNotIn(b'<script>alert(1)</script>', body)
        for path in ['/model.json', '/templates/layout.html', '/config/dashboard.json']:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.http(path)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()

    # The owner explicitly accepts the upstream middleware's lack of confinement.
    # Keep this check executable to record the accepted security limitation.
    @unittest.expectedFailure
    def test_static_assets_remain_within_public_root(self):
        escaped_link = self.web_root / 'public/escaped-model.json'
        escaped_link.symlink_to(self.web_root / 'model.json')
        try:
            for path in ['/assets/%2e%2e/model.json', '/assets/../model.json',
                         '/assets/%2e%2e/templates/layout.html', '/assets/escaped-model.json']:
                with self.subTest(path=path):
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        self.http(path)
                    self.assertEqual(error.exception.code, 404)
                    error.exception.close()
        finally:
            escaped_link.unlink()

    def test_entire_web_package_and_projection_read_model_can_be_replaced(self):
        package = self.work / 'replacement-web'
        (package / 'public').mkdir(parents=True)
        (package / 'templates').mkdir()
        site = {'title': 'Independent Observatory', 'routes': [
            {'path': '/', 'template': 'catalog.html', 'data': {}},
            {'path': '/catalog/rooms/:room/devices/:device', 'template': 'detail.html', 'data': {}}]}
        (package / 'public/site.json').write_text(json.dumps(site))
        (package / 'public/custom.css').write_text('h1 { color: navy; }')
        (package / 'templates/catalog.html').write_text(
            '<h1>{{ site.title }}</h1><section class="custom-overview">'
            '{% for row in records %}<p>{{ row.device_id }}</p>{% endfor %}</section>')
        (package / 'templates/detail.html').write_text(
            '<h1>{{ params.room }} / {{ params.device }}</h1><p>{{ query.tab }}</p>')
        self.sql("CREATE OR REPLACE VIEW ttn_dashboard.custom_observations AS SELECT * FROM "
                 "ttn_dashboard.ttn_uplinks WHERE device_id='energy-01'; "
                 "GRANT SELECT ON ttn_dashboard.custom_observations TO 'dashboard_reader'@'localhost'")
        model = json.loads((ROOT / 'web/model.json').read_text())
        for name in ['snapshot_sql', 'history_sql', 'changes_sql']:
            model[name] = model[name].replace('ttn_uplinks', 'custom_observations')
        (package / 'model.json').write_text(json.dumps(model))
        settings = copy.deepcopy(self.settings)
        settings.update(web_root=str(package), client_id='replacement-dashboard')
        config = self.work / 'replacement.json'
        config.write_text(json.dumps(settings))
        port = free_port()
        self.start('replacement-dashboard', [str(BINARY), '--config-file', str(ROOT / 'config/mqttclient.conf'),
                   '--log-level', '2', '--settings', str(config), 'web', 'local', '--port', str(port),
                   'mqtt', 'remote', '--port', str(self.local_port)])
        wait_until(lambda: self.http('/api/status', port)[0] == 200, 'replacement site')
        wait_until(lambda: b'energy-01' in self.http('/', port)[1], 'external projection read model')
        body = self.http('/', port)[1]
        self.assertIn(b'Independent Observatory', body)
        self.assertNotIn(b'Fieldnotes', body)
        self.assertNotIn(b'node-01', body)
        self.assertIn(b'north / meter', self.http('/catalog/rooms/north/devices/meter?tab=power', port)[1])
        self.assertIn(b'power', self.http('/catalog/rooms/north/devices/meter?tab=power', port)[1])
        self.assertIn(b'navy', self.http('/assets/custom.css', port)[1])
        snapshot = self.events(port).get('snapshot')
        self.assertEqual({row['device_id'] for row in snapshot['records']}, {'energy-01'})

    def test_initial_database_connection_failure_keeps_web_and_live_data_usable(self):
        settings = copy.deepcopy(self.settings)
        missing_socket = self.work / 'later.sock'
        settings['database']['socket'] = str(missing_socket)
        settings['client_id'] = 'initial-failure-dashboard'
        config = self.work / 'initial-failure.json'
        config.write_text(json.dumps(settings))
        port = free_port()
        self.start('initial-failure-dashboard', [str(BINARY), '--config-file', str(ROOT / 'config/mqttclient.conf'),
                   '--log-level', '2', '--settings', str(config), 'web', 'local', '--port', str(port),
                   'mqtt', 'remote', '--port', str(self.local_port)])
        wait_until(lambda: self.http('/', port)[0] == 200, 'web despite initial connection failure')
        events = self.events(port)
        self.assertTrue(events.get('snapshot')['unavailable'])
        events.get('status', lambda state: state['mqtt'])
        self.publish(self.message(1009))
        self.assertFalse(events.get('uplink', lambda row: row['frame_counter'] == 1009)['stored'])
        missing_socket.symlink_to(self.endpoint)
        events.get('stored', lambda batch: any(row['frame_counter'] == 1009 for row in batch['records']))

    def test_database_process_restart_restores_history_without_dashboard_restart(self):
        events = self.events()
        events.get("snapshot")
        server = self.processes[0]
        server.terminate()
        server.wait(timeout=10)
        try:
            events.get("status", lambda status: not status["database"])
            self.publish(self.message(1007))
            self.assertFalse(events.get("uplink", lambda row: row["frame_counter"] == 1007)["stored"])
        finally:
            self.start("database-restarted", server.args)
            wait_until(lambda: self.sql("SELECT 1").strip() == "1", "MariaDB restart")
        events.get("status", lambda status: status["database"])
        # MQTTStore does not replay inserts failed during its independent reconnect.
        # Re-deliver the same known mock identity until its storage path recovers.
        def redelivered():
            self.publish(self.message(1007))
            return int(self.sql("SELECT COUNT(*) FROM ttn_dashboard.ttn_uplinks WHERE frame_counter=1007")) == 1
        wait_until(redelivered, "MQTTStore recovery after explicit mock redelivery")
        events.get("stored", lambda batch: any(row["frame_counter"] == 1007 for row in batch["records"]))

    def test_arrival_while_snapshot_query_waits_is_delivered_after_snapshot(self):
        locker = subprocess.Popen(
            ["mariadb", "--no-defaults", "--socket=" + str(self.endpoint), "--user=" + self.user,
             "--batch", "--unbuffered", "--skip-column-names"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            locker.stdin.write("LOCK TABLES ttn_dashboard.ttn_uplinks WRITE; SELECT 'locked';\n")
            locker.stdin.flush()
            self.assertEqual(locker.stdout.readline().strip(), "locked")
            events = self.events()
            self.publish(self.message(1004))
            locker.stdin.write("UNLOCK TABLES;\n")
            locker.stdin.close()
            locker.wait(timeout=5)
            snapshot = events.get("snapshot")
            self.assertFalse(snapshot.get("unavailable", False))
            self.assertEqual(events.get("uplink", lambda row: row["frame_counter"] == 1004)["fport"], 10)
        finally:
            if locker.poll() is None:
                locker.terminate()
                locker.wait(timeout=5)
            locker.stdout.close()
            locker.stderr.close()

    def test_history_outage_keeps_live_sse_and_recovers(self):
        events = self.events()
        events.get("snapshot")
        self.sql("RENAME TABLE ttn_dashboard.ttn_uplinks TO ttn_dashboard.temporarily_unavailable")
        try:
            events.get("status", lambda status: not status["database"])
            self.publish(self.message(1005))
            self.assertFalse(events.get("uplink", lambda row: row["frame_counter"] == 1005)["stored"])
        finally:
            self.sql("RENAME TABLE ttn_dashboard.temporarily_unavailable TO ttn_dashboard.ttn_uplinks")
        # Re-deliver through MQTTStore after the deliberately failed projection.
        self.publish(self.message(1005))
        events.get("stored", lambda batch: any(row["frame_counter"] == 1005 for row in batch["records"]))
        self.assertTrue(events.get("status", lambda status: status["database"])["mqtt"])

    def test_initial_history_outage_and_recovery_preserve_live_messages(self):
        self.sql("RENAME TABLE ttn_dashboard.ttn_uplinks TO ttn_dashboard.temporarily_unavailable")
        try:
            events = self.events()
            self.assertTrue(events.get("snapshot")["unavailable"])
            self.publish(self.message(1006))
            self.assertEqual(events.get("uplink", lambda row: row["frame_counter"] == 1006)["fport"], 10)
        finally:
            self.sql("RENAME TABLE ttn_dashboard.temporarily_unavailable TO ttn_dashboard.ttn_uplinks")
        self.publish(self.message(1006))
        recovered = events.get("stored", lambda batch: any(row["frame_counter"] == 1006 for row in batch["records"]))
        self.assertTrue(any(row["frame_counter"] == 42 for row in recovered["records"]))

    def test_reader_cannot_write_telemetry(self):
        result = subprocess.run(["mariadb", "--no-defaults", "--socket=" + str(self.endpoint),
                                 "--user=dashboard_reader", "--password=mock-reader-password",
                                 "--execute=DELETE FROM ttn_dashboard.ttn_uplinks"],
                                capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("denied", result.stderr.lower())

    def test_reconnect_sends_fresh_snapshot(self):
        first = self.events()
        first.get("snapshot")
        first.close()
        self.publish(self.message(1003))
        wait_until(lambda: int(self.sql("SELECT COUNT(*) FROM ttn_dashboard.ttn_uplinks WHERE frame_counter=1003")) == 1,
                   "reconnect history")
        self.assertTrue(any(row["frame_counter"] == 1003 for row in self.events().get("snapshot")["records"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    arguments, remaining = parser.parse_known_args()
    BINARY = arguments.binary.resolve()
    unittest.main(argv=[__file__, *remaining], verbosity=2)
