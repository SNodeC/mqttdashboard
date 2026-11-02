import {deviceIdentity, latest, merge, select} from "./state.js";
import {discover, measurements, portDefinition} from "./devices.js";

const records = new Map();
const scope = document.querySelector("main").dataset;
const deviceSelect = document.querySelector("#device");
const portSelect = document.querySelector("#fport");
let site;

function element(tag, text, className = "") {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
}

function options(select, items, label) {
    const selected = select.value;
    select.replaceChildren(new Option(label, ""));
    for (const [value, text] of items) {
        select.add(new Option(text, value));
    }
    select.value = items.some(([value]) => value === selected) ? selected : "";
}

function render() {
    const devices = discover(records, site).filter(device =>
        (!scope.device || (device.application === scope.application && device.id === scope.device)) &&
        (!scope.location || device.location === scope.location));
    const directory = document.querySelector("#devices");
    if (directory) {
        directory.replaceChildren();
        for (const device of devices) {
            const card = element("article", "", "measurement device-card");
            const link = element("a", device.label, "device-link");
            link.href = device.href;
            card.append(element("p", device.profile.label, "eyebrow"), link,
                element("p", `${device.application} / ${device.id}`, "muted"),
                element("p", `Location: ${device.location}`, "muted"),
                element("p", `Last observation: ${new Date(device.records[0].received_at).toLocaleString()}`, "muted"),
                element("p", device.records[0].stored ? "Stored" : "Live · storage unconfirmed", "badge"));
            directory.append(card);
        }
    }
    if (deviceSelect) {
        options(deviceSelect, devices.map(device => [device.key, `${device.label} · ${device.application}`]), "All devices");
    }
    const chosen = deviceSelect?.value || "";
    const selected = devices.filter(device => !chosen || device.key === chosen);
    const ports = new Map();
    for (const device of selected) {
        for (const record of device.records) {
            const key = String(record.fport);
            if (!ports.has(key)) {
                ports.set(key, new Set());
            }
            ports.get(key).add(portDefinition(device.profile, record.fport).label);
        }
    }
    options(portSelect, [...ports].sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([port, names]) => [port, `${port} · ${[...names].sort().join(" / ")}`]), "All FPorts");
    const byKey = new Map(selected.map(device => [device.key, device]));
    const visible = select(records, chosen, portSelect.value).filter(record => byKey.has(deviceIdentity(record)));
    const current = latest(new Map(visible.map((record, index) => [index, record])));
    document.querySelector("#device-count").textContent = devices.length;
    document.querySelector("#record-count").textContent = Math.min(visible.length, 200);
    document.querySelector("#latest-time").textContent = visible.length
        ? new Date(visible[0].received_at).toLocaleTimeString() : "—";
    const title = document.querySelector("#device-title");
    if (title && devices.length) {
        title.textContent = devices[0].label;
    }
    const cards = document.querySelector("#measurements");
    cards.replaceChildren();
    for (const record of current) {
        const device = byKey.get(deviceIdentity(record));
        const card = element("article", "", "measurement");
        const heading = element("div", "", "card-heading");
        heading.append(element("span", portDefinition(device.profile, record.fport).label),
            element("span", `FPort ${record.fport}`, "port"));
        card.append(heading, element("h3", device.label),
            element("p", measurements(record, device.profile, site), "reading"),
            element("p", new Date(record.received_at).toLocaleString(), "muted"),
            element("span", record.stored ? "Stored" : "Live · storage unconfirmed",
                record.stored ? "badge stored" : "badge live"));
        cards.append(card);
    }
    const history = document.querySelector("#history");
    history.replaceChildren();
    for (const record of visible.slice(0, 200)) {
        const device = byKey.get(deviceIdentity(record));
        const row = document.createElement("tr");
        for (const value of [new Date(record.received_at).toLocaleString(), device.label,
            record.fport, measurements(record, device.profile, site), record.stored ? "Stored" : "Live"]) {
            row.append(element("td", String(value)));
        }
        history.append(row);
    }
    document.querySelector("#empty").hidden = devices.length > 0;
}

function connection(id, connected, connectedText, disconnectedText) {
    const node = document.querySelector(id);
    node.textContent = connected ? connectedText : disconnectedText;
    node.dataset.connected = String(connected);
}

async function start() {
    try {
        const response = await fetch("/assets/site.json", {cache: "no-store"});
        if (!response.ok) {
            throw new Error("Site configuration is unavailable");
        }
        site = await response.json();
        deviceSelect?.addEventListener("change", render);
        portSelect.addEventListener("change", render);
        const source = new EventSource("/api/events");
        for (const name of ["snapshot", "stored", "uplink"]) {
            source.addEventListener(name, event => {
                const data = JSON.parse(event.data);
                merge(records, name === "uplink" ? [data] : data.records);
                if (name === "snapshot") {
                    document.querySelector("#loading").hidden = true;
                }
                render();
            });
        }
        source.addEventListener("status", event => {
            const status = JSON.parse(event.data);
            connection("#mqtt-status", status.mqtt, "MQTT connected", "MQTT disconnected");
            connection("#db-status", status.database, "History available", "History unavailable");
        });
        source.onopen = () => connection("#sse-status", true, "Live connection", "Reconnecting");
        source.onerror = () => {
            connection("#sse-status", false, "Live connection", "Reconnecting");
            connection("#mqtt-status", false, "MQTT connected", "MQTT unknown");
            connection("#db-status", false, "History available", "History unknown");
        };
        render();
    } catch (error) {
        document.querySelector("#loading").textContent = error.message;
    }
}
start();
