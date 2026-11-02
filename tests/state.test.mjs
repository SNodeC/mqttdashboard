import test from "node:test";
import assert from "node:assert/strict";
import {identity, latest, merge, select} from "../web/public/state.js";

function record(fport, count, time, stored = false, device = "node-01", session = "a") {
    return {application_id: "mock-lab", device_id: device, session_id: session,
        frame_counter: count, fport, received_at: `2026-11-02T12:00:${time}.000Z`,
        values: {schema_version: 1}, stored};
}

test("snapshot/live overlap has one record and storage confirmation survives redelivery", () => {
    const records = new Map();
    const live = record(10, 1, "01");
    merge(records, [live]);
    merge(records, [{...live, stored: true}, {...live, values: {temperature_c: 999}}]);
    assert.equal(records.size, 1);
    assert.equal(records.get(identity(live)).stored, true);
    assert.deepEqual(records.get(identity(live)).values, live.values);
});

test("different FPorts retain their own latest values; older arrivals do not replace them", () => {
    const records = new Map();
    merge(records, [record(10, 3, "03"), record(30, 2, "02"), record(10, 1, "01")]);
    assert.deepEqual(latest(records).map(value => [value.fport, value.frame_counter]), [[10, 3], [30, 2]]);
});

test("session counter reset, device filters and FPort filters preserve identity", () => {
    const records = new Map();
    merge(records, [record(10, 90, "01"), record(10, 0, "02", false, "node-01", "b"),
        record(20, 1, "03", true, "node-02")]);
    assert.equal(latest(records).find(value => value.device_id === "node-01").session_id, "b");
    assert.equal(select(records, JSON.stringify(["mock-lab", "node-02"]), "20").length, 1);
    assert.equal(select(records, "", "30").length, 0);
});

test("bounded recent history retains the last reading of infrequent FPorts", () => {
    const records = new Map();
    const old = record(30, 0, "00", true);
    merge(records, [old]);
    const incoming = Array.from({length: 230}, (_, index) => ({...record(10, index + 1, "01"),
        received_at: new Date(Date.UTC(2026, 10, 2, 12, 0, index + 1)).toISOString()}));
    merge(records, incoming);
    assert.equal(records.size, 201);
    assert.equal(latest(records).find(value => value.fport === 30).frame_counter, 0);
    assert.equal(select(records)[0].frame_counter, 230);
});
