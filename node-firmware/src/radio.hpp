#pragma once
#include "protocol.hpp"

namespace mesh {
struct Reception { Frame frame; uint64_t timestamp; };
struct SignalQuality {
    uint64_t received_ms = 0;
    uint32_t boot = 0, seq = 0, read_us = 0, rx_status = 0, power = 0, f1 = 0, f2 = 0, f3 = 0;
    uint16_t accum_count = 0, fp_index_q6 = 0;
    int16_t rssi_q8 = 0, first_path_q8 = 0;
    uint8_t peer = 0, dgc = 0;
    bool valid = false;
};
class Radio {
public:
    explicit Radio(uint8_t id) : id_(id) {}
    bool init();
    void stop();
    struct Health { uint32_t status, state, fast_errors, slow_errors; };
    Health health();
    std::optional<Reception> poll();
    bool send(const Frame& frame, std::optional<uint64_t> delayed_at = {}, uint64_t* actual_tx = nullptr);
    static uint64_t delayed_time(uint64_t received_at);
    uint32_t device_id = 0, rx_errors = 0, tx_errors = 0;
    uint32_t decode_errors = 0, last_rx_error = 0;
    std::array<uint32_t, 7> received_frames{};
    // Latest poll/response/final quality, keyed by exchange boot/sequence.
    std::array<SignalQuality, 4> signal{};
    const char* init_error = "not-initialized";
private:
    uint8_t id_;
    bool listen();
    void capture_quality(const Frame& frame, uint32_t status);
};
}
