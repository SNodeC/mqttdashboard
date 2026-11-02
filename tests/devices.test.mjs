import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {discover, measurements, portDefinition} from "../web/public/devices.js";
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
    assert.equal(measurements(climate.records[0], climate.profile, site), "Temperature: 22 °C");
    assert.equal(measurements(energy.records[0], energy.profile, site), "Voltage: 24 V");
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
