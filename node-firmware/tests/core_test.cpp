#include "protocol.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <random>

using namespace mesh;
static Record range(uint8_t a, uint8_t b, int32_t mm, uint32_t seq = 1, uint32_t boot = 1) {
    return {Kind::range, a, a, b, boot, seq, mm, 0, 0};
}
static void transfer(const Mesh& from, Mesh& to, uint64_t now) {
    for (size_t i = 0; i < range_count; ++i) if (auto r = from.record(i, now)) {
        ++r->hops; r->age_ms += 10; to.receive(*r, now + 10);
    }
}
static void fill(Mesh& m, int32_t a = 4000, int32_t b = 3000, int32_t c = 5000, uint64_t now = 0) {
    assert(m.receive(range(1, 2, a), now));
    assert(m.receive(range(1, 3, b), now));
    assert(m.receive(range(2, 3, c), now));
}
static void withheld_layout(const Mesh& m, uint64_t now, Status status) {
    const auto layout = m.solve_layout(now);
    assert(layout.status == status && layout.age_ms == 0);
    for (const auto& point : layout.positions) assert(point.x_m == 0 && point.y_m == 0);
    for (const auto mm : layout.ranges_mm) assert(mm == 0);
}
static void coherent_layout() {
    for (uint8_t id = 1; id <= 3; ++id) {
        Mesh m(id); fill(m, 4000, 3000, 5000, 100);
        const auto layout = m.solve_layout(125);
        const auto own = m.solve(125);
        assert(layout.status == Status::relative && layout.age_ms == 25);
        assert((layout.ranges_mm == std::array<int32_t, 3>{4000, 3000, 5000}));
        assert(layout.positions[0].x_m == 0 && layout.positions[0].y_m == 0);
        assert(layout.positions[1].x_m == 4 && layout.positions[1].y_m == 0);
        assert(std::abs(layout.positions[2].x_m) < 1e-12 && std::abs(layout.positions[2].y_m - 3) < 1e-12);
        assert(own.status == (id == 1 ? Status::reference : Status::relative));
        assert(own.x_m == layout.positions[id - 1].x_m && own.y_m == layout.positions[id - 1].y_m);
        assert(own.age_ms == layout.age_ms);
        for (const auto edge : {std::pair<uint8_t,uint8_t>{1,2}, {1,3}, {2,3}}) {
            const auto& a = layout.positions[edge.first - 1];
            const auto& b = layout.positions[edge.second - 1];
            const auto mm = layout.ranges_mm[range_slot(edge.first, edge.second)];
            assert(std::abs(std::hypot(a.x_m - b.x_m, a.y_m - b.y_m) * 1000 - mm) < 1e-9);
        }
        withheld_layout(m, 6100, Status::missing);
    }
    Mesh invalid(0); fill(invalid);
    withheld_layout(invalid, 0, Status::missing);
    assert(invalid.solve(0).status == Status::missing);
}
static void network() {
    Mesh a(1), b(2), c(3);
    assert(a.receive(range(1, 2, 4000), 100));
    assert(a.receive(range(1, 3, 3000), 100));
    assert(b.receive(range(2, 3, 5000), 100));
    assert(a.solve(100).status == Status::missing);
    assert(b.solve(100).status == Status::missing);
    transfer(a, b, 100); transfer(b, c, 110); transfer(b, a, 120);
    const auto first = a.solve(140), second = b.solve(140), third = c.solve(140);
    assert(first.status == Status::reference && first.x_m == 0 && first.y_m == 0);
    assert(second.status == Status::relative && second.x_m == 4 && second.y_m == 0);
    assert(third.status == Status::relative && std::abs(third.x_m) < 1e-12 && std::abs(third.y_m - 3) < 1e-12);
    assert(a.solve(9000).status == Status::missing);
    assert(b.solve(9000).status == Status::missing);
    assert(!b.receive(range(1, 2, 4000), 9001));
    assert(b.receive(range(1, 2, 4100, 1, 2), 9002));
    assert(!b.record(range_slot(1, 3), 9002)); // Both ranges originated by rebooted N1 are invalidated.
    assert(!b.receive(range(1, 3, 3000, 500, 1), 9003));
    assert(b.receive(range(1, 3, 3000, 2, 2), 9004));
    assert(!b.receive(range(1, 2, 4100, 1, 2), 9005)); // Sequence is per edge, not shared between N1's edges.
}
static void geometry() {
    for (uint8_t id = 1; id <= 3; ++id) {
        Mesh m(id); fill(m);
        const auto s = m.solve(20);
        assert(s.status == (id == 1 ? Status::reference : Status::relative));
        assert(s.age_ms == 20);
    }
    // N3 may be behind N1 on the chosen x axis: triangle (0,0), (3,0), (-3,4).
    Mesh negative(3); fill(negative, 3000, 5000, 7211);
    auto s = negative.solve(1);
    assert(s.status == Status::relative && std::abs(s.x_m + 3) < 0.001 && std::abs(s.y_m - 4) < 0.001);
    Mesh impossible(2); fill(impossible, 1000, 1000, 3000);
    assert(impossible.solve(1).status == Status::inconsistent);
    withheld_layout(impossible, 1, Status::inconsistent);
    Mesh line(3); fill(line, 4000, 6000, 10000);
    assert(line.solve(1).status == Status::poor_geometry);
    withheld_layout(line, 1, Status::poor_geometry);
    Mesh decimal_line(3); fill(decimal_line, 1001, 2002, 3003);
    assert(decimal_line.solve(1).status == Status::poor_geometry);
    Mesh narrow(3); fill(narrow, 10000, 5001, 5001);
    assert(narrow.solve(1).status == Status::poor_geometry);
    Mesh empty(1); assert(empty.solve(0).status == Status::missing); // Origin is not presented as solved without geometry.
    Mesh partial(3); assert(partial.receive(range(1, 2, 4000), 0)); assert(partial.receive(range(1, 3, 3000), 0));
    assert(partial.solve(0).status == Status::missing);
    assert(partial.receive(range(2, 3, 5000), 1000));
    assert(partial.solve(5999).age_ms == 5999);
    assert(partial.solve(6000).status == Status::missing);
    // Report age carries the oldest contributing range through a fresh report and gossip.
    const auto aged = partial.solve(5900);
    Report r{3, 1, 1, aged.status, 0, 3000, aged.age_ms, 0};
    CachedReport cached{r, 5900, true};
    assert(cached.outgoing(5950)->age_ms == 5952);
    assert(!cached.outgoing(6000));
    const auto fingerprint = deployment();
    settings.line_length_mm = 8765;
    assert(deployment() == fingerprint && negative.solve(1).status == Status::relative);
    auto invalid = range(1, 2, 4000); invalid.source = 3; assert(!valid_record(invalid));
    invalid = range(1, 2, 4000); invalid.kind = static_cast<Kind>(2); assert(!valid_record(invalid));
    invalid = range(1, 2, 4000); invalid.hops = max_hops + 1; assert(!valid_record(invalid));
    invalid = range(1, 2, 4000); invalid.age_ms = max_age_ms; assert(!valid_record(invalid));
    assert(!valid_record(range(2, 1, 4000)) && !valid_record(range(1, 1, 4000)));
}
static void expiry() {
    Mesh wrap(2);
    assert(wrap.receive(range(1, 2, 4000), UINT32_MAX - 100));
    assert(wrap.record(0, uint64_t(UINT32_MAX) + 101)->age_ms == 201);
    assert(!wrap.record(0, uint64_t(UINT32_MAX) + 7000));
    assert(!wrap.record(0, uint64_t(UINT32_MAX) * 2 + 101));
    Mesh expired(2); assert(expired.receive(range(1, 2, 4000), 100));
    assert(!expired.record(0, 6100));
    assert(!expired.record(0, (1ull << 32) + 101));
    assert(!expired.record(0, (3ull << 32) + 101));
    assert(!expired.receive(range(1, 2, 4000), (3ull << 32) + 102));
    Report report{3, 1, 1, Status::relative, -3000, 4000, 0, 1};
    CachedReport cached{report, 100, true};
    assert(cached.outgoing(101)->age_ms == 3);
    assert(!cached.outgoing(6100));
    assert(!cached.outgoing((1ull << 32) + 101));
    assert(!cached.outgoing((3ull << 32) + 101));
}
static void ranging() {
    constexpr uint32_t start = UINT32_MAX - 1000, tof = 1066, da = 131072000, db = 120000000;
    const auto d = twr_distance(start, start + 2 * tof + db, start + 2 * tof + db + da,
        start + tof, start + tof + db, start + 3 * tof + db + da);
    assert(d && std::abs(*d - 5) < 0.01);
    // Independent oscillator phases and 20 ppm relative clock skew.
    const double ratio = 1.00002;
    const uint32_t b0 = 1234567;
    const uint32_t response_rx = start + 2 * tof + uint32_t(std::lround(db / ratio));
    const auto skew = twr_distance(start, response_rx, response_rx + da,
        b0, b0 + db, b0 + db + uint32_t(std::lround((da + 2.0 * tof) * ratio)));
    assert(skew && std::abs(*skew - 5) < 0.02);
    assert(!twr_distance(1, 1, 1, 1, 1, 1));
    assert(!twr_distance(0, 3000000000, 3100000000, 0, 100000000, 200000000));
    assert(!twr_distance(0, 100, 1000000, 0, 999999, 1000000));
}
static void protocol() {
    for (const auto edge : {std::pair<uint8_t,uint8_t>{1,2}, {1,3}, {2,3}}) {
        Frame f; f.type = Message::observation; f.source = edge.first; f.destination = edge.second;
        f.boot = 1; f.seq = 7; f.size = record_size;
        auto r = range(edge.first, edge.second, 4000); r.hops = 1; r.age_ms = 20;
        encode_record(r, f.body.data());
        std::array<uint8_t, 127> bytes{};
        const auto n = encode_frame(f, bytes.data(), bytes.size());
        assert(n == header_size + record_size && bytes[11] == 2);
        const auto decoded = decode_frame(bytes.data(), n, edge.second);
        assert(decoded && decoded->source == edge.first);
        const auto record = decode_record(decoded->body.data(), decoded->size);
        assert(record && record->value_mm == 4000 && record->age_ms == 20 && record->hops == 1);
        assert(!decode_frame(bytes.data(), n, edge.first));
        assert(!decode_frame(bytes.data(), n - 1, edge.second));
        assert(!decode_frame(bytes.data(), n + 1, edge.second));
        auto damaged = bytes; damaged[13] ^= 1; assert(!decode_frame(damaged.data(), n, edge.second));
        damaged = bytes; damaged[11] = 1; assert(!decode_frame(damaged.data(), n, edge.second));
        damaged = bytes; damaged[12] = 255; assert(!decode_frame(damaged.data(), n, edge.second));
        assert(encode_frame(f, bytes.data(), 4) == 0);
    }
    Report report{3, 3, 8, Status::relative, -3000, 4000, 100, 2};
    std::array<uint8_t,127> bytes{};
    encode_report(report, bytes.data());
    const auto restored = decode_report(bytes.data(), report_size);
    assert(restored && restored->source == 3 && restored->x_mm == -3000 && restored->y_mm == 4000 && restored->age_ms == 100);
    bytes[9] = 255; assert(!decode_report(bytes.data(), report_size));
    report.source = 1; encode_report(report, bytes.data()); assert(!decode_report(bytes.data(), report_size));
    report = {2, 3, 8, Status::relative, 4000, 0, 0, 0}; encode_report(report, bytes.data()); assert(decode_report(bytes.data(),report_size));
    report.y_mm = -1; encode_report(report, bytes.data()); assert(!decode_report(bytes.data(),report_size));
    report = {1, 1, 1, Status::reference, 0, 0, 0, 0}; encode_report(report, bytes.data()); assert(decode_report(bytes.data(),report_size));
    report.source = 3; encode_report(report, bytes.data()); assert(!decode_report(bytes.data(),report_size));
    Frame f; f.type = Message::observation; f.source = 1; f.destination = 3; f.boot = 1; f.seq = 7; f.size = record_size;
    encode_record(range(1,3,3000), f.body.data()); encode_frame(f,bytes.data(),bytes.size());
    // Bounded mutation corpus under ASan/UBSan.
    std::mt19937 rng(91);
    for (int i = 0; i < 20000; ++i) {
        auto input = bytes;
        for (unsigned k = 0; k < rng() % 8; ++k) input[rng() % input.size()] = rng() & 255;
        const size_t length = rng() % 128;
        const auto packet = decode_frame(input.data(), length, 3);
        if (packet) { decode_record(packet->body.data(), packet->size); decode_report(packet->body.data(), packet->size); }
    }
}
int main() { coherent_layout(); network(); geometry(); expiry(); ranging(); protocol(); puts("PASS: coherent layout, relative triangle geometry, forwarding, restart, expiry, TWR and v2 wire validation"); }
