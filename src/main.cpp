#include "Dashboard.h"
#include "Mqtt.h"

#include <core/SNodeC.h>
#include <express/legacy/in/WebApp.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <net/in/stream/legacy/SocketClient.h>
#include <utils/Config.h>

int main(int argc, char* argv[]) {
    const auto* settingsOption = utils::Config::configRoot.addOption(
        "--settings", "Dashboard JSON configuration", "file", std::string("config/dashboard.json"), CLI::TypeValidator<std::string>());
    core::SNodeC::init(argc, argv);
    int result = 1;
    try {
        const std::filesystem::path settingsPath = std::filesystem::absolute(settingsOption->as<std::string>());
        std::ifstream input(settingsPath);
        const auto settings = nlohmann::json::parse(input);
        const auto webRoot = (settingsPath.parent_path() / settings.at("web_root").get<std::string>()).lexically_normal();
        if (!std::filesystem::is_regular_file(webRoot / "public/site.json") || settings.at("reconcile_seconds").get<double>() < 1) {
            throw std::invalid_argument("Expected a web directory with public/site.json and reconcile_seconds >= 1");
        }
        Dashboard dashboard(settings, webRoot.string());
        const express::legacy::in::WebApp app("web", dashboard.router());
        app.getConfig()->setHost("127.0.0.1");
        app.listen(8080, [](const auto&, const core::socket::State& state) {
            if (state == core::socket::State::ERROR || state == core::socket::State::FATAL) {
                std::cerr << "Dashboard HTTP listener: " << state.what() << '\n';
            }
        });
        using Client = net::in::stream::legacy::SocketClient<DashboardMqttFactory, Dashboard&, const nlohmann::json&>;
        const auto client = core::socket::stream::Client<Client>(
            "mqtt",
            [](Client::Config* config) {
                config->Remote::setHost("127.0.0.1");
                config->Remote::setPort(1883);
                config->setRetry();
                config->setReconnect();
            },
            dashboard,
            settings);
        client.connect([](const auto&, const core::socket::State& state) {
            if (state == core::socket::State::ERROR || state == core::socket::State::FATAL) {
                std::cerr << "Dashboard MQTT connection: " << state.what() << '\n';
            }
        });
        result = core::SNodeC::start();
    } catch (const std::exception& error) {
        std::cerr << "Dashboard startup failed: " << error.what() << '\n';
    }
    return result;
}
