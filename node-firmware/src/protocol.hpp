#pragma once
#include "mesh.hpp"
#include <array>
#include <cstddef>

namespace mesh {
enum class Message : uint8_t { poll = 1, response, final, result, observation, report };
constexpr size_t header_size = 25, record_size = 25, report_size = 23;
struct Frame {
    Message type = Message::poll;
    uint8_t source = 0, destination = 0;
    uint32_t boot = 0, seq = 0;
    std::array<uint8_t, 32> body{};
    size_t size = 0;
};
struct Report {
    uint8_t source = 0;
    uint32_t boot = 0, seq = 0;
    Status status = Status::missing;
    int32_t x_mm = 0, y_mm = 0;
    uint32_t age_ms = 0;
    uint8_t hops = 0;
};
struct CachedReport {
    Report value;
    uint64_t received_ms = 0;
    bool present = false;
    std::optional<Report> outgoing(uint64_t now) const;
};
void put32(uint8_t* p, uint32_t value);
uint32_t get32(const uint8_t* p);
size_t encode_frame(const Frame& frame, uint8_t* out, size_t capacity);
std::optional<Frame> decode_frame(const uint8_t* bytes, size_t size, uint8_t receiver);
void encode_record(const Record& record, uint8_t* bytes);
std::optional<Record> decode_record(const uint8_t* bytes, size_t size);
void encode_report(const Report& report, uint8_t* bytes);
std::optional<Report> decode_report(const uint8_t* bytes, size_t size);
}
