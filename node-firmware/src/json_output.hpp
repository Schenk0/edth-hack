#pragma once
#include <array>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace mesh {
// Single-producer, bounded queue. Once a line starts, retain it through backpressure.
class JsonOutput {
public:
    static constexpr size_t capacity = 8, line_size = 512, chunk_size = 64;
    bool format(uint64_t now, const char* format, ...);
    bool vformat(uint64_t now, const char* format, va_list arguments);
    std::string_view next(uint64_t now, size_t available);
    void consume(size_t written);
    void clear();
    bool empty() const { return count_ == 0; }
    uint32_t dropped = 0;
private:
    struct Line { std::array<char, line_size> text; size_t length; uint64_t queued_ms; };
    std::array<Line, capacity> lines_{};
    size_t head_ = 0, count_ = 0, offset_ = 0, tail_size_ = 0, tail_offset_ = 0;
    std::array<char, chunk_size> tail_{};
};
}
