import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ageText, chartBuckets, discover, messageState, metric, portDefinition} from "../web/public/devices.js";
import {merge} from "../web/public/state.js";

const site = JSON.parse(readFileSync(new URL("../web/public/site.json", import.meta.url)));

function observation(id, values, application = "mock-lab") {
    return {application_id: application, device_id: id, session_id: "a", frame_counter: 1,
        fport: 10, received_at: "2026-11-02T12:00:00.000Z", values, stored: true};
}

test("overview discovers observed devices without inventing configured but unseen ones", () => {
    const records = new Map();
    assert.deepEqual(discover(records, site), []);
    merge(records, [observation("new-device", {temperature_c: 22})]);
    const devices = discover(records, site);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].href, "/devices/mock-lab/new-device");
});

test("different device profiles give the same FPort different meanings and routes", () => {
    const records = new Map();
    merge(records, [observation("climate-01", {temperature_c: 22}), observation("energy-01", {voltage_v: 24})]);
    const devices = discover(records, site);
    const climate = devices.find(device => device.id === "climate-01");
    const energy = devices.find(device => device.id === "energy-01");
    assert.equal(climate.href, "/environment/mock-lab/climate-01");
    assert.equal(energy.href, "/energy/mock-lab/energy-01");
    assert.equal(portDefinition(climate.profile, 10).label, "Environment");
    assert.equal(portDefinition(energy.profile, 10).label, "Electrical");
    assert.deepEqual([metric(climate, "temperature").label, metric(climate, "temperature").value, metric(climate, "temperature").unit], ["Temperature", 22, "°C"]);
    assert.deepEqual([metric(energy, "voltage").label, metric(energy, "voltage").value, metric(energy, "voltage").unit], ["Voltage", 24, "V"]);
});

test("dynamic type metadata selects a reusable dashboard; unknown types get a generic page", () => {
    const records = new Map();
    merge(records, [observation("new-meter", {device_type: "energy", voltage_v: 24}),
        observation("unknown", {device_type: "not-configured", arbitrary: 17})]);
    const devices = discover(records, site);
    assert.equal(devices.find(device => device.id === "new-meter").href, "/energy/mock-lab/new-meter");
    assert.equal(devices.find(device => device.id === "unknown").profileId, "generic");
});

test("same device IDs in different applications remain distinct and route segments are encoded", () => {
    const records = new Map();
    merge(records, [observation("sensor a/b", {}), observation("sensor a/b", {}, "other")]);
    const devices = discover(records, site);
    assert.equal(devices.length, 2);
    assert.ok(devices.some(device => device.href === "/devices/mock-lab/sensor%20a%2Fb"));
});

test("solar roles preserve zero, missing values and independent FPorts", () => {
    const records = new Map();
    merge(records, [{...observation("solar-01", {voltage_v: 0, current_a: 3.2}), fport: 20},
        {...observation("solar-01", {battery_pct: 82}), fport: 30}]);
    const device = discover(records, site)[0];
    assert.equal(metric(device, "voltage").value, 0);
    assert.equal(metric(device, "battery").value, 82);
    assert.equal(metric(device, "power").value, null);
    assert.equal(metric(device, "temperature").value, null);
});

test("message freshness expires without another uplink and differs from configuration", () => {
    const records = new Map();
    merge(records, [observation("solar-01", {})]);
    const device = discover(records, site)[0];
    const now = Date.parse(device.records[0].received_at);
    assert.equal(messageState(device, 180, now).key, "receiving");
    assert.equal(messageState(device, 180, now + 181000).key, "stale");
    merge(records, [{...observation("solar-01", {lorawan: {configured: false}}), fport: 50}]);
    assert.equal(messageState(discover(records, site)[0], 180, now).key, "unconfigured");
    assert.equal(ageText(undefined, now), "No message yet");
    assert.equal(ageText(device.records[0].received_at, now + 60000), "1 minute ago");
});

test("chart uses selected-device observations and leaves gaps instead of inventing zero", () => {
    const records = new Map();
    const now = Date.parse("2026-11-02T12:12:00Z");
    merge(records, [
        {...observation("solar-01", {voltage_v: 0}), fport: 20, received_at: "2026-11-02T12:01:30Z"},
        {...observation("solar-01", {voltage_v: 12.6}), fport: 20, frame_counter: 2, received_at: "2026-11-02T12:11:30Z"},
        {...observation("other", {voltage_v: 999}), fport: 20, received_at: "2026-11-02T12:11:40Z"}]);
    const device = discover(records, site).find(value => value.id === "solar-01");
    const buckets = chartBuckets(device, "voltage", site.chart, now);
    assert.equal(buckets.length, 12);
    assert.equal(buckets[1].value, 0);
    assert.equal(buckets[11].value, 12.6);
    assert.equal(buckets.filter(bucket => bucket.value === null).length, 10);
});
