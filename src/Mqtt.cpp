#include "Mqtt.h"

#include "Dashboard.h"

#include <algorithm>
#include <core/socket/stream/SocketConnection.h>
#include <iot/mqtt/SocketContext.h>
#include <iot/mqtt/Topic.h>
#include <iot/mqtt/packets/Connack.h>
#include <iot/mqtt/packets/Publish.h>
#include <iot/mqtt/packets/Suback.h>

DashboardMqtt::DashboardMqtt(const std::string& name, Dashboard& dashboard, const nlohmann::json& settings)
    : iot::mqtt::client::Mqtt(name, settings.at("client_id").get<std::string>(), 60, "")
    , dashboard(dashboard)
    , settings(settings) {
}

void DashboardMqtt::onConnected() {
    sendConnect(true, "", "", 0, false, settings.at("mqtt_username"), settings.at("mqtt_password"));
}

void DashboardMqtt::onDisconnected() {
    dashboard.mqttState(false);
}

void DashboardMqtt::onConnack(const iot::mqtt::packets::Connack& connack) {
    if (connack.getReturnCode() == 0) {
        sendSubscribe({iot::mqtt::Topic(settings.at("topic").get<std::string>(), 0)});
    } else {
        dashboard.mqttState(false);
        sendDisconnect();
    }
}

void DashboardMqtt::onSuback(const iot::mqtt::packets::Suback& suback) {
    const auto& codes = suback.getReturnCodes();
    dashboard.mqttState(!codes.empty() && std::all_of(codes.begin(), codes.end(), [](auto code) {
        return code <= 2;
    }));
}

void DashboardMqtt::onPublish(const iot::mqtt::packets::Publish& publish) {
    dashboard.uplink(publish.getMessage());
}

bool DashboardMqtt::onSignal(int signum) {
    sendDisconnect();
    return iot::mqtt::client::Mqtt::onSignal(signum);
}

DashboardMqttFactory::DashboardMqttFactory(Dashboard& dashboard, const nlohmann::json& settings)
    : dashboard(dashboard)
    , settings(settings) {
}

core::socket::stream::SocketContext* DashboardMqttFactory::create(core::socket::stream::SocketConnection* connection) {
    return new iot::mqtt::SocketContext(connection, new DashboardMqtt(connection->getConnectionName(), dashboard, settings));
}
