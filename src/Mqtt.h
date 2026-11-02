#pragma once

#include <core/socket/stream/SocketContextFactory.h>
#include <iot/mqtt/client/Mqtt.h>
#include <nlohmann/json.hpp>

class Dashboard;

class DashboardMqtt : public iot::mqtt::client::Mqtt {
public:
    DashboardMqtt(const std::string& name, Dashboard& dashboard, const nlohmann::json& settings);

private:
    void onConnected() final;
    void onDisconnected() final;
    void onConnack(const iot::mqtt::packets::Connack& connack) final;
    void onSuback(const iot::mqtt::packets::Suback& suback) final;
    void onPublish(const iot::mqtt::packets::Publish& publish) final;
    bool onSignal(int signum) final;

    Dashboard& dashboard;
    nlohmann::json settings;
};

class DashboardMqttFactory : public core::socket::stream::SocketContextFactory {
public:
    DashboardMqttFactory(Dashboard& dashboard, const nlohmann::json& settings);

private:
    core::socket::stream::SocketContext* create(core::socket::stream::SocketConnection* connection) final;
    Dashboard& dashboard;
    nlohmann::json settings;
};
