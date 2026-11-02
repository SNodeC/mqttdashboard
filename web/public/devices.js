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

export function portDefinition(profile, fport) {
    return profile.ports[String(fport)] || {label: `FPort ${fport}`, metrics: {}};
}

export function measurements(record, profile, site) {
    const definitions = portDefinition(profile, record.fport).metrics;
    return Object.entries(record.values).filter(([name]) => !site.hidden_fields.includes(name))
        .map(([name, value]) => {
            const [label, unit] = definitions[name] || [name, ""];
            return `${label}: ${typeof value === "object" ? JSON.stringify(value) : value}${unit ? ` ${unit}` : ""}`;
        }).join(" · ");
}
