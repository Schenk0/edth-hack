#include "mesh.hpp"
#include <algorithm>
#include <cmath>

namespace mesh {
bool valid_record(const Record& r) {
    if (!valid_node(r.source) || !r.boot || !r.seq || r.age_ms >= max_age_ms || r.hops > max_hops) return false;
    return r.kind == Kind::range && r.source == r.a && neighbors(r.a, r.b) &&
           r.a < r.b && r.value_mm > 0 && r.value_mm <= 1000000;
}

bool Mesh::receive(const Record& r, uint64_t now) {
    auto reject = [&] { ++rejected; return false; };
    if (!valid_record(r)) return reject();
    auto& boot = boots_[r.source - 1];
    if (r.boot < boot) return reject();
    if (r.boot > boot) {
        for (size_t i = 0; i < records_.size(); ++i) if (records_[i].record.source == r.source) {
            records_[i] = {};
            range_samples_[i] = {};
        }
        boot = r.boot;
    }
    const size_t slot = range_slot(r.a, r.b);
    auto& entry = records_[slot];
    // Retain sequence high-water marks even after a record expires.
    if (entry.present && r.seq <= entry.record.seq) return reject();
    entry = {r, now, true};
    auto& samples = range_samples_[slot];
    for (size_t i = samples.size() - 1; i > 0; --i) samples[i] = samples[i - 1];
    samples[0] = entry;
    ++accepted;
    return true;
}

std::optional<Record> Mesh::record(size_t slot, uint64_t now) const {
    if (slot >= records_.size() || !records_[slot].present) return {};
    const auto& entry = records_[slot];
    if (now < entry.received_ms || now - entry.received_ms >= max_age_ms) return {};
    const uint64_t age = uint64_t(entry.record.age_ms) + (now - entry.received_ms);
    if (age >= max_age_ms) return {};
    auto result = entry.record;
    result.age_ms = static_cast<uint32_t>(age);
    return result;
}

// Smooth only solver inputs. Stored records, USB measurements and gossip stay raw.
std::optional<Record> Mesh::solver_record(size_t slot, uint64_t now) const {
    if (!filter_ranges_) return record(slot, now);
    if (slot >= records_.size() || !records_[slot].present || now < records_[slot].received_ms) return {};
    std::array<int32_t, 3> values{};
    size_t count = 0;
    uint32_t oldest_age = 0;
    constexpr uint32_t window_ms = max_age_ms / 2;
    for (const auto& sample : range_samples_[slot]) {
        if (!sample.present || now < sample.received_ms || now - sample.received_ms >= window_ms) continue;
        const uint64_t age = uint64_t(sample.record.age_ms) + (now - sample.received_ms);
        if (age >= window_ms) continue;
        values[count++] = sample.record.value_mm;
        oldest_age = std::max(oldest_age, static_cast<uint32_t>(age));
    }
    if (!count) return record(slot, now);
    if (count > 1 && values[0] > values[1]) std::swap(values[0], values[1]);
    if (count > 2) {
        if (values[1] > values[2]) std::swap(values[1], values[2]);
        if (values[0] > values[1]) std::swap(values[0], values[1]);
    }
    auto result = records_[slot].record;
    result.value_mm = count == 2 ? (values[0] + values[1] + 1) / 2 : values[count / 2];
    // All selected samples contribute to the median/mean decision, including
    // the oldest one; a fresh report must not make those observations younger.
    result.age_ms = oldest_age;
    return result;
}

Layout Mesh::solve_layout(uint64_t now) const {
    const auto locate = [this](const std::optional<Record>& ab, const std::optional<Record>& ac,
                               const std::optional<Record>& bc) -> Layout {
        if (!valid_node(id_) || !ab || !ac || !bc) return {Status::missing};
        const double a = ab->value_mm / 1000.0, b = ac->value_mm / 1000.0, c = bc->value_mm / 1000.0;
        // Compare integer millimetres so an exactly collinear triangle cannot be
        // misclassified by floating-point addition roundoff.
        if (ab->value_mm + ac->value_mm < bc->value_mm ||
            ab->value_mm + bc->value_mm < ac->value_mm ||
            ac->value_mm + bc->value_mm < ab->value_mm) return {Status::inconsistent};
        const double x = (a * a + b * b - c * c) / (2 * a);
        const double y = std::sqrt(std::max(0.0, b * b - x * x));
        const double longest = std::max({a, b, c});
        // Provisional conditioning gate, not an accuracy estimate: the smallest
        // altitude must be at least 5% of the longest triangle edge.
        if (a * y / (longest * longest) < 0.05) return {Status::poor_geometry};
        const uint32_t age = std::max({ab->age_ms, ac->age_ms, bc->age_ms});
        return {Status::relative, {{{0, 0}, {a, 0}, {x, y}}},
                {{ab->value_mm, ac->value_mm, bc->value_mm}}, age};
    };
    const auto filtered = locate(solver_record(0, now), solver_record(1, now), solver_record(2, now));
    // Asynchronous edge updates can temporarily make their medians incompatible.
    // Prefer a valid fresh raw triangle rather than losing an available layout.
    if (filter_ranges_ && (filtered.status == Status::inconsistent || filtered.status == Status::poor_geometry)) {
        const auto raw = locate(record(0, now), record(1, now), record(2, now));
        if (raw.status == Status::relative) return raw;
    }
    return filtered;
}

Solution Mesh::solve(uint64_t now) const {
    const auto layout = solve_layout(now);
    if (layout.status != Status::relative) return {layout.status};
    const auto& point = layout.positions[id_ - 1];
    return {id_ == 1 ? Status::reference : Status::relative, point.x_m, point.y_m, layout.age_ms};
}

const char* status_name(Status s) {
    switch (s) {
    case Status::reference: return "reference";
    case Status::missing: return "missing-measurements";
    case Status::inconsistent: return "inconsistent-ranges";
    case Status::poor_geometry: return "poor-geometry";
    case Status::relative: return "relative";
    }
    return "unknown";
}

std::optional<double> twr_distance(uint32_t pt, uint32_t rr, uint32_t ft,
                                  uint32_t pr, uint32_t rt, uint32_t fr) {
    const double ra = uint32_t(rr - pt), rb = uint32_t(fr - rt);
    const double da = uint32_t(ft - rr), db = uint32_t(rt - pr);
    // An exchange must finish well before the ~67 ms low-word rollover.
    constexpr double max_interval = 20e-3 * 499.2e6 * 128;
    if (ra <= 0 || rb <= 0 || da <= 0 || db <= 0 ||
        ra > max_interval || rb > max_interval || da > max_interval || db > max_interval) return {};
    const double tof = (ra * rb - da * db) / (ra + rb + da + db);
    const double distance = tof * (1.0 / (499.2e6 * 128)) * 299702547.0;
    if (!std::isfinite(distance) || distance <= 0 || distance > 1000) return {};
    return distance;
}
}
