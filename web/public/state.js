// One message collection serves cards, history and persisted/live reconciliation.
export function deviceIdentity(record) {
    return JSON.stringify([record.application_id, record.device_id]);
}

export function identity(record) {
    return JSON.stringify([record.application_id, record.device_id, record.session_id,
        record.frame_counter, record.fport]);
}

export function compare(a, b) {
    const time = Date.parse(a.received_at) - Date.parse(b.received_at);
    return time || a.frame_counter - b.frame_counter || identity(a).localeCompare(identity(b));
}

export function merge(records, incoming) {
    for (const record of incoming) {
        const key = identity(record);
        const previous = records.get(key);
        records.set(key, previous?.stored && !record.stored
            ? previous : {...record, stored: Boolean(record.stored)});
    }
    const ordered = [...records.values()].sort(compare).reverse();
    const latest = new Set();
    for (const [index, record] of ordered.entries()) {
        const group = JSON.stringify([record.application_id, record.device_id, record.fport]);
        if (index >= 200 && latest.has(group)) {
            records.delete(identity(record));
        }
        latest.add(group);
    }
}

export function select(records, device = "", fport = "") {
    return [...records.values()].filter(record =>
        (!device || deviceIdentity(record) === device) &&
        (!fport || String(record.fport) === fport)).sort(compare).reverse();
}

export function latest(records) {
    const groups = new Map();
    for (const record of select(records)) {
        const key = JSON.stringify([record.application_id, record.device_id, record.fport]);
        if (!groups.has(key)) {
            groups.set(key, record);
        }
    }
    return [...groups.values()];
}
