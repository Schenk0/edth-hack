#include "mesh.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>

using namespace mesh;
static Record range(uint8_t a, uint8_t b, int32_t mm, uint32_t seq = 1,
                    uint32_t boot = 1, uint32_t age = 0) {
    return {Kind::range, a, a, b, boot, seq, mm, age, 0};
}
static void triangle(Mesh& m, uint64_t at, int32_t a, int32_t b = 6000,
                     int32_t c = 6000, uint32_t seq = 1) {
    assert(m.receive(range(1, 2, a, seq), at));
    assert(m.receive(range(1, 3, b, seq), at));
    assert(m.receive(range(2, 3, c, seq), at));
}
static int32_t x_mm(const Mesh& m, uint64_t at) {
    const auto s = m.solve(at);
    assert(s.status == Status::relative);
    return static_cast<int32_t>(std::lround(s.x_m * 1000));
}

static void spike_and_raw_contract() {
    Mesh filtered(2), raw(2, false);
    for (auto* m : {&filtered, &raw}) {
        triangle(*m, 0, 4000);
        triangle(*m, 500, 4000, 6000, 6000, 2);
        triangle(*m, 1000, 9000, 6000, 6000, 3);
    }
    assert(x_mm(filtered, 1020) == 4000);
    assert(x_mm(raw, 1020) == 9000);
    assert(filtered.solve(1020).age_ms == 1020);
    assert(raw.solve(1020).age_ms == 20);
    const auto layout = filtered.solve_layout(1020);
    assert(layout.status == Status::relative && layout.age_ms == 1020);
    assert((layout.ranges_mm == std::array<int32_t, 3>{4000, 6000, 6000}));
    assert(layout.positions[1].x_m == 4 && layout.positions[1].y_m == 0);
    for (size_t i = 0; i < 2; ++i) {
        const auto& point = layout.positions[i];
        const auto& third = layout.positions[2];
        assert(std::abs(std::hypot(point.x_m - third.x_m, point.y_m - third.y_m) - 6) < 1e-12);
    }
    // The solver must not rewrite the record used by USB measurement/gossip.
    for (size_t slot = 0; slot < range_count; ++slot) {
        const auto a = filtered.record(slot, 1020), b = raw.record(slot, 1020);
        assert(a && b && a->value_mm == b->value_mm && a->age_ms == b->age_ms);
        assert(a->source == b->source && a->boot == b->boot && a->seq == b->seq && a->hops == b->hops);
    }
    assert(filtered.record(0, 1020)->value_mm == 9000);
    assert(filtered.record(0, 1020)->age_ms == 20);
}

static void two_samples_and_capacity() {
    Mesh m(2);
    triangle(m, 0, 4000);
    triangle(m, 10, 4001, 6000, 6000, 2);
    assert(x_mm(m, 10) == 4001); // 4000.5 mm rounds to the nearest positive mm.
    assert(m.solve(10).age_ms == 10);
    triangle(m, 20, 8000, 12000, 12000, 3);
    triangle(m, 30, 10000, 12000, 12000, 4);
    assert(x_mm(m, 30) == 8000); // Only the last three accepted unique samples.
    assert(!m.receive(range(1, 2, 100000, 4), 31));
    assert(!m.receive(range(1, 2, 100000, 3), 32));
    assert(x_mm(m, 32) == 8000);
}

static void age_window_and_fallback() {
    Mesh m(2);
    assert(m.receive(range(1, 2, 4000, 1, 1, 2000), 100));
    assert(m.receive(range(1, 2, 8000, 2), 200));
    assert(m.receive(range(1, 3, 6000), 200));
    assert(m.receive(range(2, 3, 6000, 1, 1, 1700), 200));
    assert(x_mm(m, 200) == 6000);
    assert(m.solve(200).age_ms == 2100); // Oldest effective origin age, not newest receipt.
    assert(m.solve_layout(200).age_ms == 2100);
    assert((m.solve_layout(200).ranges_mm == std::array<int32_t, 3>{6000, 6000, 6000}));
    assert(x_mm(m, 1099) == 6000);
    assert(m.solve(1099).age_ms == 2999);
    assert(x_mm(m, 1100) == 8000); // Old sample reaches exactly 3000 ms and is excluded.
    assert(m.solve(1100).age_ms == 2600); // Edge23's original age still dominates.
    assert(x_mm(m, 3200) == 8000); // No 3s samples: use the still-fresh latest raw record.
    assert(m.solve(3200).age_ms == 4700);
    assert(m.solve_layout(3200).age_ms == 4700);
    assert((m.solve_layout(3200).ranges_mm == std::array<int32_t, 3>{8000, 6000, 6000}));
    assert(m.solve(4500).status == Status::missing); // Edge23 effective age reaches6000.
    assert(!m.record(2, 4500));
    // A late received sample does not acquire a fresh origin time.
    Mesh late(2);
    triangle(late, 0, 4000);
    assert(late.receive(range(1, 2, 8000, 2, 1, 3500), 100));
    assert(x_mm(late, 100) == 4000);
    assert(late.record(0, 100)->value_mm == 8000 && late.record(0, 100)->age_ms == 3500);
}

static void restart_and_expiry() {
    Mesh m(2);
    for (uint32_t seq = 1; seq <= 3; ++seq) triangle(m, seq, 4000, 6000, 6000, seq);
    assert(m.receive(range(1, 2, 8000, 1, 2), 100));
    assert(!m.record(1, 100));
    assert(m.solve(100).status == Status::missing);
    assert(m.receive(range(1, 3, 6000, 2, 2), 101));
    assert(x_mm(m, 101) == 8000); // Old boot's median history was invalidated too.
    assert(!m.receive(range(1, 2, 4000, 999, 1), 102));
    assert(m.solve(6101).status == Status::missing);
    assert(!m.receive(range(1, 2, 8000, 1, 2), 6102)); // Expiry preserves sequence high water.
    assert(!m.receive(range(1, 3, 6000, 2, 2), 6102));
}

static void clocks_and_step_response() {
    Mesh wrap(2);
    const uint64_t at = uint64_t(UINT32_MAX) - 100;
    triangle(wrap, at, 4000);
    assert(x_mm(wrap, at + 201) == 4000 && wrap.solve(at + 201).age_ms == 201);
    assert(wrap.solve(at + 6000).status == Status::missing);
    assert(wrap.solve(at + (1ull << 32) + 101).status == Status::missing);
    assert(wrap.solve(std::numeric_limits<uint64_t>::max()).status == Status::missing);
    assert(!wrap.receive(range(1, 2, 4000), at + (1ull << 32) + 102));
    Mesh backwards(2);
    triangle(backwards, 100, 4000);
    triangle(backwards, 1000, 8000, 6000, 6000, 2);
    assert(backwards.solve(500).status == Status::missing);
    assert(!backwards.record(0, 500));
    Mesh step(2);
    triangle(step, 0, 4000);
    triangle(step, 100, 4000, 6000, 6000, 2);
    triangle(step, 200, 8000, 6000, 6000, 3);
    assert(x_mm(step, 200) == 4000);
    assert(x_mm(step, 3099) == 6000);
    assert(x_mm(step, 3100) == 8000); // Responds within3s even without additional samples.
}

static void geometry_still_withheld() {
    for (const auto status : {Status::inconsistent, Status::poor_geometry}) {
        Mesh m(3);
        for (uint32_t seq = 1; seq <= 3; ++seq) {
            if (status == Status::inconsistent) triangle(m, seq, 1000, 1000, 3000, seq);
            else triangle(m, seq, 4000, 6000, 10000, seq);
        }
        assert(m.solve(4).status == status);
    }
}

static void asynchronous_geometry_fallback() {
    Mesh filtered(3), raw(3, false);
    for (auto* m : {&filtered, &raw}) {
        triangle(*m, 0, 1000, 1000, 1000);
        triangle(*m, 10, 1000, 1000, 1000, 2);
        triangle(*m, 20, 1000, 3000, 2500, 3);
        assert(m->receive(range(2, 3, 2500, 4), 30));
    }
    // Independent medians would be(1m,1m,2.5m); latest raw(1m,3m,2.5m) is valid.
    const auto a = filtered.solve(40), b = raw.solve(40);
    assert(a.status == Status::relative && b.status == Status::relative);
    assert(a.x_m == b.x_m && a.y_m == b.y_m && a.age_ms == b.age_ms && a.age_ms == 20);
    const auto layout = filtered.solve_layout(40);
    assert(layout.status == Status::relative && layout.age_ms == 20);
    assert((layout.ranges_mm == std::array<int32_t, 3>{1000, 3000, 2500}));
    assert(layout.positions[1].x_m == 1 && layout.positions[1].y_m == 0);
    assert(layout.positions[2].x_m == a.x_m && layout.positions[2].y_m == a.y_m);
    for (size_t i = 0; i < 2; ++i) {
        const auto& point = layout.positions[i];
        const auto& third = layout.positions[2];
        assert(std::abs(std::hypot(point.x_m - third.x_m, point.y_m - third.y_m) * 1000 - layout.ranges_mm[i + 1]) < 1e-9);
    }
    // If the latest raw triangle is invalid too, keep withholding the layout.
    assert(filtered.receive(range(1, 3, 1000, 4), 50));
    assert(filtered.solve(50).status == Status::inconsistent);
    assert(filtered.solve(6020).status == Status::missing);
    Mesh narrow(1);
    triangle(narrow, 0, 1000, 1000, 1000);
    triangle(narrow, 10, 1000, 1000, 1000, 2);
    triangle(narrow, 20, 1000, 2000, 2000, 3);
    assert(narrow.receive(range(2, 3, 2000, 4), 30));
    // The filtered (1m,1m,2m) line falls back to a valid raw triangle.
    const auto recovered = narrow.solve_layout(40);
    assert(recovered.status == Status::relative && recovered.age_ms == 20);
    assert((recovered.ranges_mm == std::array<int32_t, 3>{1000, 2000, 2000}));
    assert(narrow.solve(40).status == Status::reference && narrow.solve(40).age_ms == 20);
}

int main() {
    spike_and_raw_contract(); two_samples_and_capacity(); age_window_and_fallback();
    restart_and_expiry(); clocks_and_step_response(); geometry_still_withheld(); asynchronous_geometry_fallback();
    puts("PASS: solver median, raw record contract, origin ages, expiry, reboot, duplicates, clock guards and bounded step response");
}
