#include "protocol.hpp"
#include <algorithm>

namespace mesh {
std::optional<Report> CachedReport::outgoing(uint64_t now) const {
    if (!present || now < received_ms || now - received_ms >= max_age_ms || value.hops >= max_hops) return {};
    const auto age = uint64_t(value.age_ms) + now - received_ms + 2;
    if (age >= max_age_ms) return {};
    auto result = value;
    result.age_ms = static_cast<uint32_t>(age); ++result.hops;
    return result;
}
void put32(uint8_t* p, uint32_t v) { for (unsigned i = 0; i < 4; ++i) p[i] = static_cast<uint8_t>(v >> (i * 8)); }
uint32_t get32(const uint8_t* p) {
    uint32_t v = 0;
    for (unsigned i = 0; i < 4; ++i) v |= uint32_t(p[i]) << (i * 8);
    return v;
}
static size_t body_size(Message type) {
    switch (type) {
    case Message::poll: case Message::response: return 0;
    case Message::final: return 12;
    case Message::result: case Message::observation: return record_size;
    case Message::report: return report_size;
    }
    return 1000;
}
size_t encode_frame(const Frame& f, uint8_t* out, size_t capacity) {
    const size_t size = header_size + f.size;
    if (f.size != body_size(f.type) || size > capacity || !neighbors(f.source, f.destination) || !f.boot || !f.seq) return 0;
    out[0] = 0x41; out[1] = 0x88; out[2] = static_cast<uint8_t>(f.seq);
    out[3] = settings.network_id & 0xff; out[4] = settings.network_id >> 8;
    out[5] = f.destination; out[6] = 0; out[7] = f.source; out[8] = 0;
    out[9] = 'M'; out[10] = 'N'; out[11] = wire_version; out[12] = static_cast<uint8_t>(f.type);
    put32(out + 13, deployment()); put32(out + 17, f.boot); put32(out + 21, f.seq);
    std::copy_n(f.body.begin(), f.size, out + header_size);
    return size;
}
std::optional<Frame> decode_frame(const uint8_t* p, size_t size, uint8_t receiver) {
    if (size < header_size || p[0] != 0x41 || p[1] != 0x88 ||
        p[3] != (settings.network_id & 0xff) || p[4] != (settings.network_id >> 8) || p[5] != receiver || p[6] || p[8] ||
        !neighbors(p[7], receiver) || p[9] != 'M' || p[10] != 'N' || p[11] != wire_version || get32(p + 13) != deployment()) return {};
    Frame f;
    f.type = static_cast<Message>(p[12]); f.source = p[7]; f.destination = receiver;
    f.boot = get32(p + 17); f.seq = get32(p + 21); f.size = size - header_size;
    if (!f.boot || !f.seq || f.size != body_size(f.type) || f.size > f.body.size()) return {};
    std::copy_n(p + header_size, f.size, f.body.begin());
    return f;
}
void encode_record(const Record& r, uint8_t* p) {
    p[0] = static_cast<uint8_t>(r.kind); p[1] = r.source; p[2] = r.a; p[3] = r.b;
    put32(p + 4, r.boot); put32(p + 8, r.seq); put32(p + 12, static_cast<uint32_t>(r.value_mm));
    put32(p + 16, r.age_ms); p[20] = r.hops;
    std::fill_n(p + 21, 4, 0);
}
std::optional<Record> decode_record(const uint8_t* p, size_t size) {
    if (size != record_size || get32(p + 21) != 0) return {};
    Record r{static_cast<Kind>(p[0]), p[1], p[2], p[3], get32(p + 4), get32(p + 8),
             static_cast<int32_t>(get32(p + 12)), get32(p + 16), p[20]};
    return valid_record(r) ? std::optional<Record>(r) : std::nullopt;
}
void encode_report(const Report& r, uint8_t* p) {
    p[0] = r.source; put32(p + 1, r.boot); put32(p + 5, r.seq); p[9] = static_cast<uint8_t>(r.status);
    put32(p + 10, static_cast<uint32_t>(r.x_mm)); put32(p + 14, static_cast<uint32_t>(r.y_mm));
    put32(p + 18, r.age_ms); p[22] = r.hops;
}
std::optional<Report> decode_report(const uint8_t* p, size_t size) {
    if (size != report_size) return {};
    Report r{p[0], get32(p + 1), get32(p + 5), static_cast<Status>(p[9]),
             static_cast<int32_t>(get32(p + 10)), static_cast<int32_t>(get32(p + 14)), get32(p + 18), p[22]};
    if (!valid_node(r.source) || !r.boot || !r.seq || r.age_ms >= max_age_ms || r.hops > max_hops ||
        p[9] > static_cast<uint8_t>(Status::relative) || r.x_mm < -1000000 || r.x_mm > 1000000 || r.y_mm < 0 || r.y_mm > 1000000) return {};
    if ((r.status != Status::reference && r.status != Status::relative) && (r.x_mm || r.y_mm)) return {};
    if (r.status == Status::reference && (r.source != 1 || r.x_mm || r.y_mm)) return {};
    if (r.status == Status::relative && (r.source == 1 || (r.source == 2 && (r.x_mm <= 0 || r.y_mm)) || (r.source == 3 && r.y_mm <= 0))) return {};
    return r;
}
}
