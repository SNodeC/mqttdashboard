#pragma once

#include <core/timer/Timer.h>
#include <cstdint>
#include <database/mariadb/MariaDBClient.h>
#include <express/Router.h>
#include <functional>
#include <list>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace express {
    class Response;
}

class Dashboard {
public:
    Dashboard(const nlohmann::json& settings, const std::string& webRoot);
    ~Dashboard();
    const express::Router& router() const;
    void mqttState(bool connected);
    void uplink(const std::string& payload);

private:
    struct Receiver {
        std::shared_ptr<express::Response> response;
        std::optional<std::uint64_t> cursor;
        bool initialized = false;
        bool querying = false;
        nlohmann::json pending = nlohmann::json::array();
    };

    static void send(const std::shared_ptr<express::Response>& response, const std::string& event, const nlohmann::json& data);
    void query(const std::string& sql,
               const std::function<void(const nlohmann::json&, std::uint64_t)>& done,
               const std::function<void()>& failed);
    void read(const std::shared_ptr<Receiver>& receiver);
    static void unavailable(const std::shared_ptr<Receiver>& receiver);
    void status();
    nlohmann::json state() const;

    express::Router routes;
    nlohmann::json model;
    bool mqttConnected = false;
    bool databaseConnected = false;
    bool historyAvailable = false;
    database::mariadb::MariaDBClient database;
    std::list<std::shared_ptr<Receiver>> receivers;
    core::timer::Timer reconcileTimer;
};
