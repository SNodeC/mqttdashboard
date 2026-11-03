import {deviceIdentity, select} from "./state.js";

// Discovery is derived from observations; configured labels do not invent devices.
export function discover(records, site) {
    const groups = new Map();
    for (const record of select(records)) {
        const key = deviceIdentity(record);
        if (!groups.has(key)) {
            const settings = site.devices[`${record.application_id}/${record.device_id}`] || {};
            groups.set(key, {key, application: record.application_id, id: record.device_id,
                label: settings.label || record.device_id, location: settings.location || site.default_location,
                profileId: settings.profile || record.values.device_type || site.default_profile,
                records: []});
        }
        groups.get(key).records.push(record);
    }
    const devices = [...groups.values()];
    for (const device of devices) {
        if (!Object.hasOwn(site.profiles, device.profileId)) {
            device.profileId = site.default_profile;
        }
        device.profile = site.profiles[device.profileId];
        const parameters = {application: device.application, device: device.id, location: device.location};
        device.href = device.profile.route.replace(/:([a-zA-Z_][a-zA-Z_0-9]*)/g,
            (_, name) => encodeURIComponent(parameters[name]));
    }
    return devices.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

// Every page resolves visual roles through the selected device's FPort profile.
export function metric(device, role) {
    const binding = device?.profile.roles?.[role];
    const record = binding ? device.records.find(item => item.fport === binding.fport &&
        Object.hasOwn(item.values, binding.field)) : undefined;
    const definition = binding ? portDefinition(device.profile, binding.fport).metrics[binding.field] : undefined;
    return {value: record?.values[binding.field] ?? null, record,
        label: definition?.[0] || role, unit: definition?.[1] || ""};
}

export function ageText(timestamp, now = Date.now()) {
    const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
    let text = "No message yet";
    if (Number.isFinite(seconds)) {
        const [unit, size] = seconds < 60 ? ["second", 1] : seconds < 3600
            ? ["minute", 60] : seconds < 86400 ? ["hour", 3600] : ["day", 86400];
        text = new Intl.RelativeTimeFormat("en", {numeric: "always"}).format(-Math.floor(seconds / size), unit);
    }
    return text;
}

export function messageState(device, timeoutSeconds, now = Date.now()) {
    const configured = metric(device, "radio").value?.configured;
    const time = Date.parse(device?.records[0]?.received_at);
    let state = {key: "unknown", label: "No observations"};
    if (configured === false) {
        state = {key: "unconfigured", label: "Not configured"};
    } else if (Number.isFinite(time)) {
        state = now - time <= timeoutSeconds * 1000
            ? {key: "receiving", label: "Receiving messages"}
            : {key: "stale", label: "No recent messages"};
    }
    return state;
}

export function chartBuckets(device, role, chart, now = Date.now()) {
    const binding = device?.profile.roles?.[role];
    const duration = chart.minutes * 60000 / chart.buckets;
    const start = now - chart.minutes * 60000;
    const buckets = Array.from({length: chart.buckets}, (_, index) =>
        ({start: start + index * duration, value: null}));
    for (const record of device?.records || []) {
        const time = Date.parse(record.received_at);
        const value = binding && record.fport === binding.fport ? record.values[binding.field] : null;
        const index = Math.min(chart.buckets - 1, Math.floor((time - start) / duration));
        if (time >= start && time <= now && typeof value === "number" && Number.isFinite(value) && buckets[index].value === null) {
            buckets[index].value = value;
        }
    }
    return buckets;
}

export function portDefinition(profile, fport) {
    return profile.ports[String(fport)] || {label: `FPort ${fport}`, metrics: {}};
}
