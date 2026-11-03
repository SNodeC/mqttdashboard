import {merge} from "./state.js";
import {ageText, chartBuckets, discover, messageState, metric} from "./devices.js";

const records = new Map();
const scope = document.querySelector("main").dataset;
const connection = {sse: false, mqtt: null, database: null};
let site;
let initialized = false;

function text(selector, value) {
    for (const node of document.querySelectorAll(selector)) {
        node.textContent = value;
    }
}

function number(value, digits = 1) {
    return typeof value === "number" && Number.isFinite(value)
        ? new Intl.NumberFormat(document.documentElement.lang, {maximumFractionDigits: digits}).format(value) : "—";
}

function directory(devices, now) {
    const grid = document.querySelector("#devices");
    if (grid) {
        const add = document.querySelector("#add-device");
        for (const device of devices) {
            let card = [...grid.querySelectorAll("[data-device-key]")].find(node => node.dataset.deviceKey === device.key);
            if (!card) {
                card = document.querySelector("#device-card").content.firstElementChild.cloneNode(true);
                card.dataset.deviceKey = device.key;
                grid.insertBefore(card, add);
            }
            const state = messageState(device, site.message_timeout_seconds, now);
            card.href = device.href;
            card.dataset.state = state.key;
            card.querySelector("[data-device-label]").textContent = device.label;
            card.title = `${device.application} / ${device.id} · ${device.location}`;
            const badge = card.querySelector("[data-message-state]");
            badge.className = `chip ${state.key}`;
            badge.querySelector("span").textContent = state.label;
            badge.querySelector("i").hidden = state.key !== "receiving";
        }
    }
}

function links(device) {
    const application = device?.application || scope.application;
    const id = device?.id || scope.device;
    const base = application && id ? `/devices/${encodeURIComponent(application)}/${encodeURIComponent(id)}` : "";
    const primary = device?.profile.primary_metric || "voltage";
    const paths = {home: "/", dashboard: device?.href || base || "/", network: `${base}/network`,
        lorawan: `${base}/lorawan`, words: `${base}/learn/lorawan`, primary: `${base}/learn/${primary}`};
    for (const role of site.lesson_order) {
        paths[role] = `${base}/learn/${role}`;
    }
    for (const link of document.querySelectorAll("[data-link]")) {
        link.href = paths[link.dataset.link] || "/";
    }
}

function measurements(device) {
    for (const role of site.lesson_order) {
        const item = metric(device, role);
        text(`[data-value="${role}"]`, number(item.value));
        text(`[data-unit="${role}"]`, item.unit);
    }
    const role = device?.profile.primary_metric || "voltage";
    const item = metric(device, role);
    const range = role === "temperature" ? [0, 60] : device?.profile.voltage_range || [0, 14];
    text("[data-primary-value]", number(item.value));
    text("[data-primary-unit]", item.unit);
    text("[data-primary-label]", item.label);
    text(".primary-symbol", item.unit || "V");
    text("[data-range-min]", `${range[0]} ${item.unit} min`);
    text("[data-range-max]", `${range[1]} ${item.unit} max`);
    const gauge = document.querySelector("#voltage-gauge");
    if (gauge) {
        gauge.value = typeof item.value === "number" ? Math.max(0, Math.min(100, (item.value - range[0]) / (range[1] - range[0]) * 100)) : 0;
        gauge.setAttribute("aria-valuetext", `${number(item.value)} ${item.unit}`);
    }
    const battery = metric(device, "battery").value;
    for (const [index, block] of [...document.querySelectorAll(".battery-outline i")].entries()) {
        block.classList.toggle("filled", typeof battery === "number" && index < Math.round(battery / 20));
    }
}

function chart(device, now) {
    const container = document.querySelector("#chart");
    if (container) {
        const role = device?.profile.primary_metric || "voltage";
        const range = role === "temperature" ? [0, 60] : device?.profile.voltage_range || [0, 14];
        const buckets = chartBuckets(device, role, site.chart, now);
        if (container.children.length !== buckets.length) {
            container.replaceChildren(...buckets.map(() => document.createElement("span")));
        }
        for (const [index, bucket] of buckets.entries()) {
            const bar = container.children[index];
            bar.className = bucket.value === null ? "chart-bar gap" : "chart-bar";
            bar.style.height = bucket.value === null ? "2px" : `${Math.max(0, Math.min(100, (bucket.value - range[0]) / (range[1] - range[0]) * 100))}%`;
            bar.title = `${new Date(bucket.start).toLocaleTimeString()}: ${bucket.value === null ? "No observation" : number(bucket.value) + " " + metric(device, role).unit}`;
        }
        const count = buckets.filter(bucket => bucket.value !== null).length;
        text("#chart-coverage", count < buckets.length ? `${count}/${buckets.length} intervals observed · gaps are not zero` : "");
        text("[data-chart-minutes]", site.chart.minutes);
        container.setAttribute("aria-label", `${metric(device, role).label}, last ${site.chart.minutes} minutes; ${count} observed intervals out of ${buckets.length}`);
    }
}

function gps(device, now) {
    const observation = metric(device, "gps");
    const value = observation.value;
    const known = typeof value?.latitude === "number" && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 &&
        typeof value?.longitude === "number" && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
    const recent = known && value?.fix === true && now - Date.parse(value.fix_received_at || observation.record?.received_at) <= site.message_timeout_seconds * 1000;
    const warning = document.querySelector("#gps-warning");
    if (warning) {
        warning.classList.toggle("gps-valid", recent);
        warning.querySelector("span").textContent = recent
            ? "GPS fix found. The location is reported by the device."
            : "GPS location cannot be retrieved. Make sure the device is outside.";
    }
    text("#coordinates", known ? `${Math.abs(value.latitude).toFixed(4)}° ${value.latitude < 0 ? "S" : "N"}, ${Math.abs(value.longitude).toFixed(4)}° ${value.longitude < 0 ? "W" : "E"}` : "No known location");
    text("#gps-age", known ? `${recent ? "Last updated" : "Last known fix"}: ${ageText(value.fix_received_at || observation.record.received_at, now)}` : "No GPS observation");
    document.querySelector(".map-illustration")?.classList.toggle("no-location", !known);
}

function radio(device, now) {
    const value = metric(device, "radio").value;
    for (const node of document.querySelectorAll("[data-radio]")) {
        const field = node.dataset.radio;
        let display = value?.[field] ?? "—";
        if (typeof display === "number") {
            if (field === "rssi_dbm") {
                display = `${number(display)} dBm`;
            } else if (field === "snr_db") {
                display = `${number(display)} dB`;
            } else if (field === "frequency_hz") {
                display = `${number(display / 1000000, 3)} MHz`;
            } else if (field === "spreading_factor") {
                display = `SF${display}`;
            }
        }
        if (field === "device_class" && display !== "—") {
            display = `Class ${display}`;
        }
        if (field === "messages_today" && value?.count_date !== new Date(now).toISOString().slice(0, 10)) {
            display = "—";
        }
        node.textContent = String(display);
    }
    // Signal bars describe mock radio observations, independently of MQTT/SSE state.
    const strength = value?.rssi_dbm;
    const quality = typeof strength === "number" && Number.isFinite(strength)
        ? strength >= -100 ? "Good" : strength >= -115 ? "Fair" : "Weak" : "Unknown";
    text("[data-signal]", quality);
    for (const bars of document.querySelectorAll(".signal-bars")) {
        bars.dataset.quality = quality.toLowerCase();
    }
}

function deviceState(device, now) {
    const latest = device?.records[0];
    const state = messageState(device, site.message_timeout_seconds, now);
    text("[data-age]", ageText(latest?.received_at, now));
    text("[data-device-status]", state.label);
    for (const node of document.querySelectorAll("[data-device-status]")) {
        node.dataset.state = state.key;
    }
    text("[data-frame-counter]", latest?.frame_counter ?? "—");
    text("[data-last-uplink]", latest ? new Date(latest.received_at).toLocaleString() : "—");
    text("[data-storage]", latest ? latest.stored ? "Stored" : "Live · storage unconfirmed" : "");
    text("#device-title", device?.label || scope.device || "");
    const payload = document.querySelector("#last-payload");
    if (payload) {
        payload.textContent = latest ? JSON.stringify(latest.values, null, 2) : "No decoded payload yet.";
    }
}

function serviceState() {
    const note = document.querySelector("#connection-note");
    const problems = [];
    if (!connection.sse) {
        problems.push("Live connection reconnecting");
    }
    if (connection.mqtt !== true) {
        problems.push(connection.mqtt === false ? "MQTT disconnected" : "MQTT status unknown");
    }
    if (connection.database !== true) {
        problems.push("Stored history unavailable");
    }
    note.hidden = problems.length === 0 || !initialized;
    note.textContent = problems.join(" · ");
    text("#mqtt-status", `MQTT status: ${connection.mqtt === true ? "connected" : connection.mqtt === false ? "disconnected" : "unknown"}`);
    for (const dot of document.querySelectorAll('[data-connection="mqtt"]')) {
        dot.dataset.connected = String(connection.mqtt === true);
    }
}

function render() {
    if (site) {
        const now = Date.now();
        const devices = discover(records, site).filter(device => !scope.location || device.location === scope.location);
        const selected = devices.find(device => device.application === scope.application && device.id === scope.device);
        document.querySelector("#empty").hidden = !initialized || (scope.device ? Boolean(selected) : devices.length > 0);
        directory(devices, now);
        links(selected);
        measurements(selected);
        chart(selected, now);
        gps(selected, now);
        radio(selected, now);
        deviceState(selected, now);
        serviceState();
    }
}

async function start() {
    try {
        const response = await fetch("/assets/site.json", {cache: "no-store"});
        if (!response.ok) {
            throw new Error("Site configuration is unavailable");
        }
        site = await response.json();
        document.querySelector("#add-device")?.addEventListener("click", () => document.querySelector("#onboarding").showModal());
        for (const button of document.querySelectorAll("[data-mock]")) {
            button.addEventListener("click", () => {
                const notice = document.querySelector("#mock-notice");
                notice.textContent = `${button.dataset.mock} is a mock button for now. Click this message to dismiss it.`;
                notice.hidden = false;
            });
        }
        document.querySelector("#mock-notice").addEventListener("click", event => {
            event.currentTarget.hidden = true;
        });
        const source = new EventSource("/api/events");
        for (const name of ["snapshot", "stored", "uplink"]) {
            source.addEventListener(name, event => {
                const data = JSON.parse(event.data);
                merge(records, name === "uplink" ? [data] : data.records, site.retention);
                if (name === "snapshot") {
                    initialized = true;
                    document.querySelector("#loading").hidden = true;
                }
                render();
            });
        }
        source.addEventListener("status", event => {
            Object.assign(connection, JSON.parse(event.data));
            serviceState();
        });
        source.onopen = () => {
            connection.sse = true;
            serviceState();
        };
        source.onerror = () => {
            Object.assign(connection, {sse: false, mqtt: null, database: null});
            serviceState();
        };
        // One UI clock updates ages and stale states even when the publisher is silent.
        window.setInterval(render, 1000);
        render();
    } catch (error) {
        document.querySelector("#loading").textContent = error.message;
    }
}

start();
