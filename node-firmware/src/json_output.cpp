#include "json_output.hpp"
#include <algorithm>
#include <cstdio>

namespace mesh {
bool JsonOutput::format(uint64_t now, const char* format, ...) {
    va_list arguments; va_start(arguments, format);
    const bool accepted = vformat(now, format, arguments);
    va_end(arguments); return accepted;
}
bool JsonOutput::vformat(uint64_t now, const char* format, va_list arguments) {
    if (count_ == capacity) { ++dropped; return false; }
    auto& line = lines_[(head_ + count_) % capacity];
    const int length = vsnprintf(line.text.data(), line.text.size(), format, arguments);
    if (length <= 0 || static_cast<size_t>(length) >= line.text.size()) { ++dropped; return false; }
    size_t n = static_cast<size_t>(length);
    while (n && (line.text[n - 1] == '\n' || line.text[n - 1] == '\r')) --n;
    if (!n || line.text[0] != '{' || line.text[n - 1] != '}' ||
        std::string_view(line.text.data(), n).find_first_of("\r\n") != std::string_view::npos) { ++dropped; return false; }
    line.length = n - 1; // Closing brace/newline is committed with the delay trailer.
    line.queued_ms = now; ++count_; return true;
}
std::string_view JsonOutput::next(uint64_t now, size_t available) {
    if (!count_ || !available) return {};
    const auto& line = lines_[head_];
    if (offset_ < line.length)
        return {line.text.data() + offset_, std::min({line.length - offset_, available, chunk_size})};
    if (!tail_size_) {
        // Wait for room for the entire trailer, then timestamp it just before write.
        // TinyUSB has one foreground producer and cannot consume less than available.
        if (available < tail_.size()) return {};
        tail_size_ = static_cast<size_t>(snprintf(tail_.data(), tail_.size(), ",\"usb_delay_ms\":%llu}\n",
            static_cast<unsigned long long>(now - line.queued_ms)));
    }
    return {tail_.data() + tail_offset_, std::min(tail_size_ - tail_offset_, available)};
}
void JsonOutput::consume(size_t written) {
    if (!count_) return;
    const auto& line = lines_[head_];
    if (offset_ < line.length) offset_ += std::min(written, line.length - offset_);
    else tail_offset_ += std::min(written, tail_size_ - tail_offset_);
    if (offset_ == line.length && tail_size_ && tail_offset_ == tail_size_) {
        head_ = (head_ + 1) % capacity; --count_;
        offset_ = tail_size_ = tail_offset_ = 0;
    }
}
void JsonOutput::clear() {
    dropped += static_cast<uint32_t>(count_);
    head_ = count_ = offset_ = tail_size_ = tail_offset_ = 0;
}
}
