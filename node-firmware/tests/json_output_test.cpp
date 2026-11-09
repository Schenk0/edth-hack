#include "json_output.hpp"
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <fstream>
#include <string>

// Full-speed CDC: 64 bytes in flight and 64 queued. The host can stop draining.
struct Usb {
    std::string fifo, endpoint, received;
    size_t available() const { return 64 - fifo.size(); }
    size_t write(std::string_view bytes) {
        const size_t n = std::min(bytes.size(), available()); fifo.append(bytes.substr(0, n)); return n;
    }
    void flush() { if (endpoint.empty()) endpoint.swap(fifo); }
    void host_read() { received += endpoint; endpoint.clear(); flush(); }
};
static void poll(mesh::JsonOutput& output, Usb& usb, uint64_t now) {
    const auto bytes = output.next(now, usb.available());
    assert(bytes.size() <= 64); output.consume(usb.write(bytes)); usb.flush();
}
int main() {
    mesh::JsonOutput output; Usb usb;
    const std::string padding(300, 'x');
    assert(output.format(10, "{\"v\":1,\"type\":\"setup\",\"ok\":true,\"message\":\"%s\"}\n", padding.c_str()));
    assert(output.format(10, "{\"v\":1,\"type\":\"setup\",\"ok\":true,\"message\":\"second\"}"));
    for (int i = 0; i < 100; ++i) poll(output, usb, 20);
    assert(usb.fifo.size() + usb.endpoint.size() == 128);
    assert(!output.empty()); // No SDK-style silent truncation after the first 128 bytes.
    for (size_t i = 2; i < mesh::JsonOutput::capacity; ++i)
        assert(output.format(10, "{\"v\":1,\"type\":\"setup\",\"ok\":true,\"message\":\"queued\"}"));
    assert(!output.format(10, "{\"v\":1,\"message\":\"must-drop-whole\"}"));
    assert(output.dropped == 1);
    for (int i = 0; i < 300; ++i) { usb.host_read(); poll(output, usb, 10010); }
    usb.host_read(); usb.host_read();
    assert(output.empty());
    assert(std::count(usb.received.begin(), usb.received.end(), '\n') == mesh::JsonOutput::capacity);
    assert(usb.received.find(padding) != std::string::npos);
    assert(usb.received.find("must-drop-whole") == std::string::npos);
    assert(usb.received.find("\"usb_delay_ms\":10000") != std::string::npos);
    std::ofstream("build-host/usb-output.jsonl") << usb.received;
    // Oversized formatting must not leak a prefix into the stream.
    assert(!output.format(0, "{\"message\":\"%s\"}", std::string(600, 'y').c_str()));
    assert(output.empty());
    assert(output.format(0, "{\"message\":\"disconnect\"}"));
    output.clear(); assert(output.empty());
    assert(output.format(1, "{\"message\":\"reconnected\"}"));
    Usb reconnected;
    for (int i = 0; i < 20; ++i) { poll(output, reconnected, 2); reconnected.host_read(); }
    assert(reconnected.received == "{\"message\":\"reconnected\",\"usb_delay_ms\":1}\n");
    puts("PASS: complete USB lines survive backpressure, queue overflow and reconnect; queued age is preserved");
}
