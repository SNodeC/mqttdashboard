#include "Dashboard.h"

#include <algorithm>
#include <express/Request.h>
#include <express/Response.h>
#include <express/middleware/StaticMiddleware.h>
#include <fstream>
#include <inja/inja.hpp>
#include <iostream>
#include <utility>
#include <web/http/server/SocketContext.h>

namespace {
    nlohmann::json readJson(const std::string& file) {
        std::ifstream input(file);
        return nlohmann::json::parse(input);
    }
} // namespace

Dashboard::Dashboard(const nlohmann::json& settings, const std::string& webRoot)
    : database({.connectionName = "dashboard-read",
                .hostname = settings.at("database").at("host").get<std::string>(),
                .username = settings.at("database").at("username").get<std::string>(),
                .password = settings.at("database").at("password").get<std::string>(),
                .database = settings.at("database").at("name").get<std::string>(),
                .port = settings.at("database").at("port").get<std::uint16_t>(),
                .socket = settings.at("database").at("socket").get<std::string>(),
                .flags = 0},
               [this](const database::mariadb::MariaDBState& connection) {
                   databaseConnected = connection.connected;
                   if (!databaseConnected) {
                       historyAvailable = false;
                   }
                   const auto active = receivers;
                   for (const auto& receiver : active) {
                       if (databaseConnected) {
                           read(receiver);
                       } else {
                           unavailable(receiver);
                       }
                   }
                   status();
               }) {
    model = readJson(webRoot + "/model.json");
    routes.get("/api/events", [this] APPLICATION(req, res) {
        if (req->get("Accept").find("text/event-stream") != std::string::npos) {
            res->set("Content-Type", "text/event-stream")
                .set("Connection", "keep-alive")
                .set("Cache-Control", "no-cache, no-transform")
                .set("X-Accel-Buffering", "no");
            res->sendHeader();
            res->sendFragment("retry: 2000");
            res->sendFragment();
            auto receiver = std::make_shared<Receiver>();
            receiver->response = res;
            receivers.push_back(receiver);
            res->getSocketContext()->setOnDisconnected([this, weak = std::weak_ptr<Receiver>(receiver)] {
                receivers.remove_if([&weak](const auto& candidate) {
                    return candidate == weak.lock();
                });
            });
            send(res, "status", state());
            read(receiver);
        } else {
            res->status(406).json({{"error", "Use Accept: text/event-stream"}});
        }
    });
    routes.get("/api/status", [this] APPLICATION(req, res) {
        res->set("Cache-Control", "no-store").json(state());
    });
    routes.get("/api/history", [this] APPLICATION(req, res) {
        query(
            model.at("history_sql"),
            [this, res](const auto& records, std::uint64_t) {
                if (res->isConnected()) {
                    res->set("Cache-Control", "no-store").json({{"records", records}, {"limit", model.at("history_limit")}});
                }
            },
            [res] {
                if (res->isConnected()) {
                    res->status(503).json({{"error", "Stored history is temporarily unavailable"}});
                }
            });
    });
    const auto site = readJson(webRoot + "/public/site.json");
    for (const auto& page : site.at("routes")) {
        routes.get(page.at("path").get<std::string>(), [this, webRoot, page] APPLICATION(req, res) {
            const auto render = [webRoot, page, params = req->params, queries = req->queries, path = req->path, res](
                                    const nlohmann::json& records, std::uint64_t) {
                try {
                    inja::Environment environment(webRoot + "/templates/");
                    environment.set_html_autoescape(true);
                    const nlohmann::json context = {{"site", readJson(webRoot + "/public/site.json")},
                                                    {"page", page.at("data")},
                                                    {"params", params},
                                                    {"query", queries},
                                                    {"path", path},
                                                    {"records", records}};
                    if (res->isConnected()) {
                        res->set("Content-Type", "text/html; charset=utf-8")
                            .set("Cache-Control", "no-store")
                            .send(environment.render_file(page.at("template").get<std::string>(), context));
                    }
                } catch (const std::exception& error) {
                    std::cerr << "Template rendering failed: " << error.what() << '\n';
                    if (res->isConnected()) {
                        res->status(500).send("Page template could not be rendered");
                    }
                }
            };
            query(model.at("snapshot_sql"), render, [render] {
                render(nlohmann::json::array(), 0);
            });
        });
    }
    routes.use("/assets", express::middleware::StaticMiddleware(webRoot + "/public").appendStdHeaders("Cache-Control", "no-store"));
    database.connect();
    reconcileTimer = core::timer::Timer::intervalTimer(
        [this] {
            // Copy the list because disconnect callbacks may remove receivers.
            const auto active = receivers;
            for (const auto& receiver : active) {
                if (const auto& response = receiver->response; response->isConnected()) {
                    response->sendFragment(": keep-alive");
                    response->sendFragment();
                    read(receiver);
                }
            }
        },
        settings.at("reconcile_seconds").get<double>());
}

Dashboard::~Dashboard() {
    reconcileTimer.cancel();
}

const express::Router& Dashboard::router() const {
    return routes;
}

nlohmann::json Dashboard::state() const {
    return {{"mqtt", mqttConnected}, {"database", historyAvailable}, {"mock_format", model.value("mock_format", false)}};
}

void Dashboard::status() {
    const auto active = receivers;
    for (const auto& receiver : active) {
        send(receiver->response, "status", state());
    }
}

void Dashboard::mqttState(bool connected) {
    mqttConnected = connected;
    status();
}

void Dashboard::send(const std::shared_ptr<express::Response>& response, const std::string& event, const nlohmann::json& data) {
    if (response->isConnected()) {
        response->sendFragment("event: " + event);
        response->sendFragment("data: " + data.dump());
        response->sendFragment();
    }
}

void Dashboard::uplink(const std::string& payload) {
    try {
        const auto envelope = nlohmann::json::parse(payload);
        nlohmann::json record = {{"stored", false}};
        for (const auto& [field, pointer] : model.at("live").items()) {
            record[field] = envelope.at(nlohmann::json::json_pointer(pointer.get<std::string>()));
        }
        if (!record.at("values").is_object() || record.at("fport") < 1 || record.at("fport") > 223) {
            throw std::invalid_argument("Invalid decoded payload or FPort");
        }
        const auto active = receivers;
        for (const auto& receiver : active) {
            if (const auto& response = receiver->response; response->isConnected()) {
                if (receiver->initialized) {
                    send(response, "uplink", record);
                } else if (receiver->pending.size() < 1000) {
                    receiver->pending.push_back(record);
                } else {
                    response->getSocketContext()->close();
                }
            }
        }
    } catch (const std::exception&) {
        std::cerr << "Ignored an uplink outside the configured data contract\n";
    }
}

void Dashboard::query(const std::string& sql,
                      const std::function<void(const nlohmann::json&, std::uint64_t)>& done,
                      const std::function<void()>& failed) {
    if (databaseConnected) {
        auto records = std::make_shared<nlohmann::json>(nlohmann::json::array());
        auto cursor = std::make_shared<std::uint64_t>(0);
        database.query(
            sql,
            [this, records, cursor, done](const MYSQL_ROW row) {
                if (row != nullptr) {
                    records->push_back(nlohmann::json::parse(row[1]));
                    *cursor = std::max(*cursor, static_cast<std::uint64_t>(std::stoull(row[0])));
                } else {
                    historyAvailable = true;
                    done(*records, *cursor);
                }
            },
            [this, failed](const std::string& error, unsigned int number) {
                historyAvailable = false;
                std::cerr << "Dashboard query failed: " << number << " " << error << '\n';
                failed();
                status();
            });
    } else {
        database.connect();
        failed();
    }
}

void Dashboard::read(const std::shared_ptr<Receiver>& receiver) {
    if (databaseConnected && !receiver->querying) {
        receiver->querying = true;
        const auto sql = inja::render(model.at(receiver->cursor.has_value() ? "changes_sql" : "snapshot_sql").get<std::string>(),
                                      {{"cursor", receiver->cursor.value_or(0)}});
        query(
            sql,
            [this, receiver](const auto& records, std::uint64_t cursor) {
                receiver->querying = false;
                receiver->cursor = std::max(receiver->cursor.value_or(0), cursor);
                if (const auto& response = receiver->response; response->isConnected()) {
                    if (!receiver->initialized || !records.empty()) {
                        send(response, receiver->initialized ? "stored" : "snapshot", {{"records", records}});
                    }
                    receiver->initialized = true;
                    for (const auto& message : receiver->pending) {
                        send(response, "uplink", message);
                    }
                    receiver->pending.clear();
                    send(response, "status", state());
                }
            },
            [receiver] {
                unavailable(receiver);
            });
    } else if (!databaseConnected) {
        database.connect();
    }
}

void Dashboard::unavailable(const std::shared_ptr<Receiver>& receiver) {
    receiver->querying = false;
    if (const auto& response = receiver->response; response->isConnected() && !receiver->initialized) {
        send(response, "snapshot", {{"records", nlohmann::json::array()}, {"unavailable", true}});
        for (const auto& message : receiver->pending) {
            send(response, "uplink", message);
        }
        receiver->pending.clear();
        receiver->initialized = true;
    }
}
