#pragma once
#include "config.hpp"
#include <array>
#include <cstddef>
#include <optional>

namespace mesh {
enum class Kind : uint8_t { range = 1 };
struct Record {
    Kind kind = Kind::range;
    uint8_t source = 0, a = 0, b = 0;
    uint32_t boot = 0, seq = 0;
    int32_t value_mm = 0;
    uint32_t age_ms = 0;
    uint8_t hops = 0;
};
bool valid_record(const Record& record);
struct Stored { Record record; uint64_t received_ms = 0; bool present = false; };
enum class Status : uint8_t { reference, missing, inconsistent, poor_geometry, relative };
const char* status_name(Status status);
struct Solution { Status status; double x_m = 0, y_m = 0; uint32_t age_ms = 0; };
struct Point { double x_m = 0, y_m = 0; };
struct Layout {
    Status status = Status::missing;
    std::array<Point, 3> positions{};
    std::array<int32_t, 3> ranges_mm{};
    uint32_t age_ms = 0;
};

// Every MCU solves the canonical triangle from one set of range inputs.
// Positive y is a convention; the real layout's mirror ambiguity remains.
class Mesh {
public:
    explicit Mesh(uint8_t id, bool filter_ranges = true) : id_(id), filter_ranges_(filter_ranges) {}
    bool receive(const Record& record, uint64_t now);
    std::optional<Record> record(size_t slot, uint64_t now) const;
    Layout solve_layout(uint64_t now) const;
    Solution solve(uint64_t now) const;
    uint32_t accepted = 0, rejected = 0;
private:
    uint8_t id_;
    bool filter_ranges_;
    std::array<Stored, range_count> records_{};
    std::array<std::array<Stored, 3>, range_count> range_samples_{};
    std::array<uint32_t, 3> boots_{};
    std::optional<Record> solver_record(size_t slot, uint64_t now) const;
};

// Asymmetric double-sided TWR, with unsigned subtraction across 32-bit DTU wrap.
std::optional<double> twr_distance(uint32_t poll_tx, uint32_t response_rx, uint32_t final_tx,
                                  uint32_t poll_rx, uint32_t response_tx, uint32_t final_rx);
}
