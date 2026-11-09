#include "radio.hpp"
#include "setup.hpp"
#include "usb_output.hpp"
#include "pico/stdlib.h"
#include "pico/rand.h"
#include "pico/unique_id.h"
#include "hardware/watchdog.h"
#include "hardware/gpio.h"
#include <cmath>
#include <cstdio>
#include <limits>
#include <cstring>

using namespace mesh;
static uint8_t id = 0;
static bool radio_ready = false;
static char unique[PICO_UNIQUE_BOARD_ID_SIZE_BYTES * 2 + 1];
static Mesh state(id);
static Radio radio(id);
static uint32_t boot, sequence = 0, ranges_ok = 0, ranges_failed = 0;
static constexpr const char* local_filter_json = R"(,"position_filter":"median3-3s")";
static uint64_t now_ms() { return time_us_64() / 1000; }
static uint32_t next_seq() {
    if (sequence == std::numeric_limits<uint32_t>::max()) {
        watchdog_reboot(0, 0, 0); while (true) tight_loop_contents();
    }
    return ++sequence;
}
static Frame frame(Message type, uint8_t to, uint32_t exchange_boot, uint32_t seq) {
    Frame f;
    f.type = type; f.source = id; f.destination = to; f.boot = exchange_boot; f.seq = seq;
    return f;
}
static void print_record(const Record& r) {
    usb_logf("{\"v\":1,\"type\":\"measurement\",\"receiver\":\"N%u\",\"kind\":\"%s\",\"source\":\"N%u\","
           "\"a\":%u,\"b\":%u,\"boot\":%lu,\"seq\":%lu,\"value_mm\":%ld,\"age_ms\":%lu,\"hops\":%u,\"mode\":\"live\"}\n",
           id, "range", r.source, r.a, r.b,
           static_cast<unsigned long>(r.boot), static_cast<unsigned long>(r.seq), static_cast<long>(r.value_mm),
           static_cast<unsigned long>(r.age_ms), r.hops);
}
static bool ingest(Record r) {
    if (!state.receive(r, now_ms())) return false;
    print_record(r); return true;
}
static std::optional<Reception> wait_for(Message type, uint8_t from, uint32_t origin_boot, uint32_t seq) {
    const auto deadline = make_timeout_time_ms(12);
    while (!time_reached(deadline)) {
        const auto rx = radio.poll();
        if (rx && rx->frame.type == type && rx->frame.source == from &&
            rx->frame.boot == origin_boot && rx->frame.seq == seq) return rx;
        // Gossip is repeated periodically; unrelated packets may be lost during ranging.
        tight_loop_contents();
    }
    return {};
}
static const char* initiate_stage = "not-attempted";
static bool initiate(uint8_t peer) {
    const uint32_t seq = next_seq();
    const uint64_t started = now_ms();
    uint64_t poll_tx;
    initiate_stage = "poll-tx";
    if (!radio.send(frame(Message::poll, peer, boot, seq), {}, &poll_tx)) return false;
    initiate_stage = "response-timeout";
    const auto response = wait_for(Message::response, peer, boot, seq);
    if (!response) return false;
    const auto final_tx = Radio::delayed_time(response->timestamp);
    auto final = frame(Message::final, peer, boot, seq);
    final.size = 12;
    put32(final.body.data(), static_cast<uint32_t>(poll_tx));
    put32(final.body.data() + 4, static_cast<uint32_t>(response->timestamp));
    put32(final.body.data() + 8, static_cast<uint32_t>(final_tx));
    initiate_stage = "final-tx";
    if (!radio.send(final, final_tx)) return false;
    initiate_stage = "result-timeout";
    const auto result = wait_for(Message::result, peer, boot, seq);
    if (!result) return false;
    auto r = decode_record(result->frame.body.data(), result->frame.size);
    if (!r || r->kind != Kind::range || r->source != id || r->a != id || r->b != peer || r->boot != boot || r->seq != seq || r->hops) return false;
    r->age_ms = static_cast<uint32_t>(now_ms() - started);
    // Defer USB work until the timestamp-sensitive exchange has finished.
    initiate_stage = "ready";
    return ingest(*r);
}
static const char* respond_stage = "not-attempted";
static bool respond(const Reception& poll) {
    const auto& p = poll.frame;
    if (p.source >= id) return false;
    const uint64_t started = now_ms();
    const uint64_t response_tx = Radio::delayed_time(poll.timestamp);
    respond_stage = "response-tx";
    if (!radio.send(frame(Message::response, p.source, p.boot, p.seq), response_tx)) return false;
    respond_stage = "final-timeout";
    const auto final = wait_for(Message::final, p.source, p.boot, p.seq);
    if (!final) return false;
    const auto* times = final->frame.body.data();
    const auto distance = twr_distance(get32(times), get32(times + 4), get32(times + 8),
        static_cast<uint32_t>(poll.timestamp), static_cast<uint32_t>(response_tx), static_cast<uint32_t>(final->timestamp));
    respond_stage = "invalid-distance";
    if (!distance) return false;
    Record r{Kind::range, p.source, p.source, id, p.boot, p.seq,
        static_cast<int32_t>(std::lround(*distance * 1000)), static_cast<uint32_t>(now_ms() - started + 2), 0};
    respond_stage = "invalid-record";
    if (!valid_record(r)) return false;
    auto result = frame(Message::result, p.source, p.boot, p.seq);
    result.size = record_size; encode_record(r, result.body.data());
    const bool sent = radio.send(result);
    respond_stage = sent ? "ready" : "result-tx";
    ingest(r);
    return sent;
}

static std::array<CachedReport, 3> reports;
static void print_report(const Report& r) {
    const bool located = r.status == Status::relative || r.status == Status::reference;
    char x[24] = "null", y[24] = "null";
    if (located) { snprintf(x, sizeof(x), "%.3f", r.x_mm / 1000.0); snprintf(y, sizeof(y), "%.3f", r.y_mm / 1000.0); }
    usb_logf("{\"v\":1,\"type\":\"report\",\"receiver\":\"N%u\",\"source\":\"N%u\",\"boot\":%lu,\"seq\":%lu,\"status\":\"%s\",\"x_m\":%s,"
        "\"y_m\":%s,\"residual_m\":null,\"age_ms\":%lu,\"hops\":%u,\"coordinate_frame\":\"%s\",\"reflection_ambiguous\":true,\"calibrated\":false%s}",
        id, r.source, static_cast<unsigned long>(r.boot), static_cast<unsigned long>(r.seq), status_name(r.status), x,
        y, static_cast<unsigned long>(r.age_ms), r.hops, coordinate_frame, r.source == id ? local_filter_json : "");
}
// A single node supplies one internally consistent triangle to the USB display.
// Peer-owned reports remain unchanged on the radio network.
static void print_layout(const Layout& layout, uint32_t seq) {
    char positions[220] = "null", ranges[50] = "null";
    if (layout.status == Status::relative) {
        const auto mm = [](double value) { return std::lround(value * 1000) / 1000.0; };
        snprintf(positions, sizeof(positions),
            "[{\"id\":\"N1\",\"x_m\":%.3f,\"y_m\":%.3f},{\"id\":\"N2\",\"x_m\":%.3f,\"y_m\":%.3f},{\"id\":\"N3\",\"x_m\":%.3f,\"y_m\":%.3f}]",
            mm(layout.positions[0].x_m), mm(layout.positions[0].y_m),
            mm(layout.positions[1].x_m), mm(layout.positions[1].y_m),
            mm(layout.positions[2].x_m), mm(layout.positions[2].y_m));
        snprintf(ranges, sizeof(ranges), "[%ld,%ld,%ld]", static_cast<long>(layout.ranges_mm[0]),
            static_cast<long>(layout.ranges_mm[1]), static_cast<long>(layout.ranges_mm[2]));
    }
    usb_logf("{\"v\":1,\"type\":\"layout\",\"receiver\":\"N%u\",\"source\":\"N%u\",\"boot\":%lu,\"seq\":%lu,\"status\":\"%s\","
        "\"age_ms\":%lu,\"hops\":0,\"coordinate_frame\":\"%s\",\"reflection_ambiguous\":true,\"calibrated\":false,\"positions\":%s,\"ranges_mm\":%s}",
        id, id, static_cast<unsigned long>(boot), static_cast<unsigned long>(seq), status_name(layout.status),
        static_cast<unsigned long>(layout.age_ms), coordinate_frame, positions, ranges);
}
static void accept_report(Report r) {
    if (r.source == id) return;
    auto& old = reports[r.source - 1];
    if (old.present && (r.boot < old.value.boot || (r.boot == old.value.boot && r.seq <= old.value.seq))) return;
    old = {r, now_ms(), true}; print_report(r);
}
static void receive(const Reception& rx) {
    const auto& f = rx.frame;
    if (f.type == Message::poll) {
        if (respond(rx)) ++ranges_ok; else ++ranges_failed;
    } else if (f.type == Message::observation) {
        auto r = decode_record(f.body.data(), f.size);
        if (r && r->source != id && r->hops) { r->age_ms += 2; ingest(*r); }
    } else if (f.type == Message::report) {
        auto r = decode_report(f.body.data(), f.size);
        if (r && r->hops) { r->age_ms += 2; if (r->age_ms < max_age_ms) accept_report(*r); }
    }
}
static void print_signal_quality() {
    static constexpr const char* names[] = {"", "poll", "response", "final"};
    for (size_t i = 1; i < radio.signal.size(); ++i) {
        const auto& q = radio.signal[i];
        if (!q.peer || now_ms() - q.received_ms >= max_age_ms) continue;
        char rssi[16] = "null", first_path[16] = "null";
        if (q.valid) {
            snprintf(rssi, sizeof(rssi), "%.2f", q.rssi_q8 / 256.0);
            snprintf(first_path, sizeof(first_path), "%.2f", q.first_path_q8 / 256.0);
        }
        usb_logf("{\"v\":1,\"type\":\"radio-quality\",\"source\":\"N%u\",\"peer\":\"N%u\",\"frame\":\"%s\",\"boot\":%lu,\"seq\":%lu,\"age_ms\":%llu,"
            "\"valid\":%s,\"rssi_dbm\":%s,\"first_path_dbm\":%s,\"cir_power\":%lu,\"f1\":%lu,\"f2\":%lu,\"f3\":%lu,\"accum_count\":%u,\"dgc\":%u,\"fp_index_q6\":%u,\"read_us\":%lu,\"rx_status\":\"%08lx\"}",
            id, q.peer, names[i], static_cast<unsigned long>(q.boot), static_cast<unsigned long>(q.seq),
            static_cast<unsigned long long>(now_ms() - q.received_ms), q.valid ? "true" : "false", rssi, first_path,
            static_cast<unsigned long>(q.power), static_cast<unsigned long>(q.f1), static_cast<unsigned long>(q.f2), static_cast<unsigned long>(q.f3),
            q.accum_count, q.dgc, q.fp_index_q6, static_cast<unsigned long>(q.read_us), static_cast<unsigned long>(q.rx_status));
    }
}
static void refresh_report() {
    const auto layout = state.solve_layout(now_ms());
    const auto& point = layout.positions[id - 1];
    const auto status = layout.status == Status::relative && id == 1 ? Status::reference : layout.status;
    Report r{id, boot, next_seq(), status, static_cast<int32_t>(std::lround(point.x_m * 1000)),
        static_cast<int32_t>(std::lround(point.y_m * 1000)), layout.age_ms, 0};
    reports[id - 1] = {r, now_ms(), true}; print_report(r);
    print_layout(layout, r.seq);
    usb_logf("{\"v\":1,\"type\":\"diagnostics\",\"source\":\"N%u\",\"uptime_ms\":%llu,\"ranges_ok\":%lu,\"ranges_failed\":%lu,"
        "\"accepted\":%lu,\"rejected\":%lu,\"rx_errors\":%lu,\"tx_errors\":%lu,\"usb_dropped\":%lu,"
        "\"rx_frames\":[%lu,%lu,%lu,%lu,%lu,%lu],\"decode_errors\":%lu,\"rx_last_error\":\"%08lx\",\"respond_stage\":\"%s\",\"initiate_stage\":\"%s\"}\n", id,
        static_cast<unsigned long long>(now_ms()), static_cast<unsigned long>(ranges_ok), static_cast<unsigned long>(ranges_failed),
        static_cast<unsigned long>(state.accepted), static_cast<unsigned long>(state.rejected),
        static_cast<unsigned long>(radio.rx_errors), static_cast<unsigned long>(radio.tx_errors), static_cast<unsigned long>(usb_log_dropped()),
        static_cast<unsigned long>(radio.received_frames[1]), static_cast<unsigned long>(radio.received_frames[2]),
        static_cast<unsigned long>(radio.received_frames[3]), static_cast<unsigned long>(radio.received_frames[4]),
        static_cast<unsigned long>(radio.received_frames[5]), static_cast<unsigned long>(radio.received_frames[6]),
        static_cast<unsigned long>(radio.decode_errors), static_cast<unsigned long>(radio.last_rx_error), respond_stage, initiate_stage);
    print_signal_quality();
}
// Rotate one record/report per neighbor per tick. Retransmission preserves origin age.
static void gossip() {
    static uint8_t slot = 0, peer = 1;
    const uint8_t item = slot, destination = peer;
    peer = peer % 3 + 1;
    if (peer == 1) slot = (slot + 1) % 6;
    if (!neighbors(id, destination)) return;
    if (item < range_count) {
        auto r = state.record(item, now_ms());
        if (r && r->hops < max_hops) {
            ++r->hops; r->age_ms += 2;
            if (r->age_ms < max_age_ms) {
                auto f = frame(Message::observation, destination, boot, next_seq());
                f.size = record_size; encode_record(*r, f.body.data()); radio.send(f);
            }
        }
    } else {
        if (auto r = reports[item - range_count].outgoing(now_ms())) {
            auto f = frame(Message::report, destination, boot, next_seq());
            f.size = report_size; encode_report(*r, f.body.data()); radio.send(f);
        }
    }
}
static void print_identity() {
    usb_logf("{\"v\":1,\"type\":\"identity\",\"source\":\"N%u\",\"node_id\":%u,\"setup_version\":1,\"geometry\":\"relative-triangle\",\"wire_version\":2,\"board_id\":\"%s\",\"boot\":%lu,\"network\":%lu,"
        "\"line_length_mm\":%lu,\"channel\":%u,\"tx_power\":\"%08lx\",\"tx_ant_delay\":%lu,\"rx_ant_delay\":%lu,\"radio_ready\":%s,\"cs_gpio\":%u,\"reset_gpio\":%u,\"irq_gpio\":%u,\"layout_version\":1%s}\n",
        id, id, unique, static_cast<unsigned long>(boot), static_cast<unsigned long>(settings.network_id),
        static_cast<unsigned long>(settings.line_length_mm), UWB_CHANNEL, static_cast<unsigned long>(settings.tx_power),
        static_cast<unsigned long>(settings.tx_ant_delay), static_cast<unsigned long>(settings.rx_ant_delay), radio_ready ? "true" : "false",
        UWB_CS_PIN, UWB_RST_PIN, UWB_IRQ_PIN, local_filter_json);
}
static void reboot() {
    usb_log_finish(150); watchdog_reboot(0, 0, 0); while (true) tight_loop_contents();
}
static void setup_command(std::string_view line) {
    const auto command = parse_setup(line);
    if (!command) { usb_logf("{\"v\":1,\"type\":\"setup\",\"ok\":false,\"message\":\"Invalid command or settings\"}"); return; }
    if (command->command == Command::get) { print_identity(); return; }
    if (command->command == Command::health) {
        if (!radio_ready) { usb_logf("{\"v\":1,\"type\":\"radio-health\",\"ok\":false}"); return; }
        const auto h = radio.health();
        usb_logf("{\"v\":1,\"type\":\"radio-health\",\"status\":\"%08lx\",\"state\":\"%08lx\",\"fast_errors\":%lu,\"slow_errors\":%lu,\"reads_per_rate\":256}",
            static_cast<unsigned long>(h.status), static_cast<unsigned long>(h.state),
            static_cast<unsigned long>(h.fast_errors), static_cast<unsigned long>(h.slow_errors));
        return;
    }
    if (command->command == Command::test) {
        const bool resume_mesh = radio_ready;
        const bool ok = radio.init();
        if (ok && !resume_mesh) radio.stop();
        radio_ready = resume_mesh && ok;
        usb_logf("{\"v\":1,\"type\":\"radio-test\",\"ok\":%s,\"device_id\":\"%08lx\",\"stage\":\"%s\",\"mesh_running\":%s,\"cs_gpio\":%u,\"reset_gpio\":%u,\"irq_gpio\":%u,\"reset_high\":%s}",
            ok ? "true" : "false", static_cast<unsigned long>(radio.device_id), radio.init_error, radio_ready ? "true" : "false",
            UWB_CS_PIN, UWB_RST_PIN, UWB_IRQ_PIN, gpio_get(UWB_RST_PIN) ? "true" : "false");
        return;
    }
    if (command->command == Command::reboot) {
        usb_logf("{\"v\":1,\"type\":\"setup\",\"ok\":true,\"message\":\"Restarting. Reconnect USB.\"}"); reboot();
    }
    if (!memcmp(&settings, &command->settings, sizeof(settings))) {
        usb_logf("{\"v\":1,\"type\":\"setup\",\"ok\":true,\"message\":\"Settings already saved\"}"); return;
    }
    if (radio_ready) radio.stop();
    if (!save_settings(&command->settings)) {
        usb_logf("{\"v\":1,\"type\":\"setup\",\"ok\":false,\"message\":\"Settings write failed. Previous settings retained.\"}");
        if (radio_ready) radio_ready = radio.init();
        return;
    }
    usb_logf("{\"v\":1,\"type\":\"setup\",\"ok\":true,\"message\":\"Saved. Restarting. Reconnect USB.\"}"); reboot();
}
// Bounded, newline-delimited USB commands; oversized input is discarded in full.
static void poll_setup() {
    static char buffer[128];
    static size_t used = 0;
    static bool overflow = false;
    for (unsigned i = 0; i < 64; ++i) {
        const int c = getchar_timeout_us(0);
        if (c == PICO_ERROR_TIMEOUT) break;
        if (c == '\r') continue;
        if (c == '\n') {
            if (overflow) usb_logf("{\"v\":1,\"type\":\"setup\",\"ok\":false,\"message\":\"Command too long\"}");
            else if (used) setup_command(std::string_view(buffer, used));
            used = 0; overflow = false;
        } else if (used < sizeof(buffer) && !overflow) buffer[used++] = static_cast<char>(c);
        else overflow = true;
    }
}
int main() {
    stdio_init_all();
    boot = start_boot(&settings);
    id = static_cast<uint8_t>(settings.node_id);
    state = Mesh(id); radio = Radio(id);
    radio_ready = boot && id && radio.init();
    pico_get_unique_board_id_string(unique, sizeof(unique));
    uint64_t next_range = now_ms() + 500 + get_rand_32() % 700;
    uint64_t next_gossip = now_ms() + get_rand_32() % 100, next_status = now_ms();
    uint64_t next_radio_retry = now_ms() + 1000;
    uint8_t next_peer = id == 1 ? 2 : 3;
    while (true) {
        usb_log_poll();
        poll_setup();
        const uint64_t now = now_ms();
        if (!radio_ready) {
            // Recover from a transient radio startup failure after USB power-up.
            if (boot && valid_node(id) && now >= next_radio_retry) {
                radio_ready = radio.init();
                next_radio_retry = now_ms() + 1000;
                if (radio_ready) {
                    next_range = now_ms() + 500 + get_rand_32() % 700;
                    next_status = now_ms();
                    continue;
                }
            }
            if (now >= next_status) {
                print_identity();
                if (!boot || id) usb_logf("{\"v\":1,\"type\":\"error\",\"source\":\"N%u\",\"reason\":\"%s\",\"stage\":\"%s\",\"device_id\":\"%08lx\"}\n",
                    id, boot ? "radio-init-failed-check-wiring" : "boot-journal-failed", radio.init_error,
                    static_cast<unsigned long>(radio.device_id));
                next_status = now_ms() + 1000;
            }
            sleep_ms(1); continue;
        }
        if (auto rx = radio.poll()) receive(*rx);
        if (now >= next_range && id < 3) {
            if (initiate(next_peer)) ++ranges_ok; else ++ranges_failed;
            if (id == 1) next_peer = next_peer == 2 ? 3 : 2;
            next_range = now_ms() + 650 + get_rand_32() % 600;
        }
        if (now >= next_gossip) {
            gossip(); next_gossip = now_ms() + 20 + get_rand_32() % 35;
        }
        if (now >= next_status) {
            print_identity(); refresh_report(); next_status = now_ms() + 1000;
        }
        tight_loop_contents();
    }
}
