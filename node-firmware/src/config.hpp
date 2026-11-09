#pragma once
#include "settings.h"
#include <cstdint>
#include <cstddef>

namespace mesh {
inline node_settings_t settings{0, NETWORK_ID, LINE_LENGTH_MM, UWB_TX_ANT_DELAY, UWB_RX_ANT_DELAY, UWB_TX_POWER};
constexpr uint32_t max_age_ms = 6000;
constexpr uint8_t max_hops = 4;
constexpr uint8_t wire_version = 2;
constexpr size_t range_count = 3;
constexpr const char* coordinate_frame = "relative-n1-n2-positive-y";
// The legacy baseline stays in flash; the room solver uses only measured ranges.
inline uint32_t deployment() { return (2166136261u ^ settings.network_id) * 16777619u ^ wire_version; }
constexpr bool valid_node(uint8_t id) { return id >= 1 && id <= 3; }
constexpr bool neighbors(uint8_t a, uint8_t b) {
    return valid_node(a) && valid_node(b) && a != b;
}
// Ordered edge slots: 12, 13, 23. range_count is the invalid-slot sentinel.
constexpr size_t range_slot(uint8_t a, uint8_t b) {
    return a == 1 && b == 2 ? 0 : a == 1 && b == 3 ? 1 : a == 2 && b == 3 ? 2 : range_count;
}
}
