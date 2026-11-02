cmake_minimum_required(VERSION 3.20)
project(
    ttn_dashboard
    VERSION 0.1.0
    LANGUAGES CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
find_package(
    snodec 2.1 REQUIRED COMPONENTS mqtt-client net-in-stream-legacy
                                   http-server-express-legacy-in db-mariadb
)
find_package(nlohmann_json 3.8 REQUIRED)
option(BUILD_TESTING "Enable development tests (Python and Node required)" OFF)
if(NOT EXISTS
   "${CMAKE_CURRENT_SOURCE_DIR}/checkouts/inja/include/inja/inja.hpp"
)
    message(
        FATAL_ERROR
            "Initialize the Inja dependency: git submodule update --init checkouts/inja"
    )
endif()

add_executable(mqttdashboard src/main.cpp src/Dashboard.cpp src/Mqtt.cpp)
target_include_directories(
    mqttdashboard SYSTEM
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/checkouts/inja/include
)
target_link_libraries(
    mqttdashboard
    PRIVATE snodec::mqtt-client snodec::net-in-stream-legacy
            snodec::http-server-express-legacy-in snodec::db-mariadb
            nlohmann_json::nlohmann_json
)
target_compile_options(mqttdashboard PRIVATE -Wall -Wextra -Wpedantic)
option(DASHBOARD_CLANG_TIDY "Run clang-tidy while compiling" OFF)
if(DASHBOARD_CLANG_TIDY)
    find_program(CLANG_TIDY clang-tidy REQUIRED)
    set_target_properties(
        mqttdashboard PROPERTIES CXX_CLANG_TIDY "${CLANG_TIDY}"
    )
endif()
list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(format)
if(CLANG_FORMAT)
    add_custom_target(
        format-check COMMAND ${CLANG_FORMAT} --dry-run --Werror
                             ${CHECK_CXX_SOURCE_FILES}
    )
endif()

include(CTest)
if(BUILD_TESTING)
    find_package(
        Python3
        COMPONENTS Interpreter
        REQUIRED
    )
    find_program(NODE_EXECUTABLE node REQUIRED)
    add_test(
        NAME pipeline
        COMMAND
            ${Python3_EXECUTABLE}
            ${CMAKE_CURRENT_SOURCE_DIR}/tests/integration.py
            $<TARGET_FILE:mqttdashboard>
    )
    set_tests_properties(pipeline PROPERTIES TIMEOUT 120)
    add_test(
        NAME browser-state
        COMMAND
            ${NODE_EXECUTABLE} --test
            ${CMAKE_CURRENT_SOURCE_DIR}/tests/state.test.mjs
            ${CMAKE_CURRENT_SOURCE_DIR}/tests/devices.test.mjs
    )
    add_test(NAME browser-syntax
             COMMAND ${NODE_EXECUTABLE} --check
                     ${CMAKE_CURRENT_SOURCE_DIR}/web/public/app.js
    )
endif()
