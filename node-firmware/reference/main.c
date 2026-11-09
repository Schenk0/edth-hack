#include "port.h"
#include "dwmac.h"
#include "dwproto.h"
#include "ranging.h"
#include "pico/stdlib.h"
#include "pico/rand.h"
#include "pico/unique_id.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>

#define LIBDECA_REVISION "226f3db3bc4ef2be9c143e8340a3851cd571cce9"
#define ROLE (REFERENCE_INITIATOR ? "initiator" : "responder")
#define LOCAL_ADDRESS (REFERENCE_INITIATOR ? 0xa001 : 0xa002)
#define PEER_ADDRESS (REFERENCE_INITIATOR ? 0xa002 : 0xa001)

static node_settings_t settings = {0, NETWORK_ID, 0, UWB_TX_ANT_DELAY, UWB_RX_ANT_DELAY, UWB_TX_POWER};
static uint32_t boot;
static char unique[PICO_UNIQUE_BOARD_ID_SIZE_BYTES * 2 + 1];
static struct { uint64_t source, destination; uint16_t distance_cm, sequence; bool pending; } result;
static uint32_t results, overwritten, watchdog_resets;

static void range_done(uint64_t source, uint64_t destination, uint16_t distance_cm, uint16_t sequence) {
    if (result.pending) ++overwritten;
    result.source = source;
    result.destination = destination;
    result.distance_cm = distance_cm;
    result.sequence = sequence;
    result.pending = true;
}
static void receive(const struct rxbuf* rx) {
    if (dwprot_check_min_len(rx->buf, rx->len) &&
        (dwprot_get_func(rx->buf) & DWMAC_PROTO_MSG_MASK) == TWR_MSG_GROUP)
        twr_handle_message(rx);
}
static void identity(bool ready) {
    printf("{\"type\":\"reference-identity\",\"library\":\"libdeca\",\"revision\":\"%s\",\"role\":\"%s\","
        "\"board_id\":\"%s\",\"saved_node_id\":%" PRIu32 ",\"boot\":%" PRIu32 ",\"network\":%" PRIu32 ","
        "\"address\":%u,\"peer\":%u,\"channel\":%u,\"tx_power\":\"%08" PRIx32 "\","
        "\"tx_ant_delay\":%" PRIu32 ",\"rx_ant_delay\":%" PRIu32 ",\"processing_us\":%u,\"ready\":%s}\n",
        LIBDECA_REVISION, ROLE, unique, settings.node_id, boot, settings.network_id,
        LOCAL_ADDRESS, PEER_ADDRESS, UWB_CHANNEL, settings.tx_power, settings.tx_ant_delay,
        settings.rx_ant_delay, REFERENCE_PROCESSING_US, ready ? "true" : "false");
}
int main(void) {
    stdio_init_all();
    boot = start_boot(&settings);
    pico_get_unique_board_id_string(unique, sizeof(unique));
    srand(get_rand_32());
    bool ready = boot && settings.node_id && reference_radio_init(&settings);
    if (ready) {
        ready = dwmac_init(settings.network_id, LOCAL_ADDRESS, receive, NULL, NULL);
        dwmac_set_frame_filter();
        dwmac_set_rx_reenable(true);
        twr_init(REFERENCE_PROCESSING_US, true);
        twr_set_observer(range_done);
        reference_restart_rx();
    }
    uint64_t next_status = 0, next_range = time_us_64() + 1000000, exchange_started = 0;
    while (true) {
        const uint64_t now = time_us_64();
        if (!ready) {
            if (now >= next_status) { identity(false); next_status = now + 1000000; }
            sleep_ms(10);
            continue;
        }
        reference_poll();
        if (REFERENCE_INITIATOR && !twr_in_progress() && now >= next_range) {
            exchange_started = now;
            next_range = now + 1000000;
            twr_start(PEER_ADDRESS);
        }
        if (REFERENCE_INITIATOR && twr_in_progress() && now - exchange_started > 250000) {
            twr_cancel();
            reference_restart_rx();
            ++watchdog_resets;
        }
        if (result.pending && !twr_in_progress()) {
            const bool valid = result.distance_cm < TWR_OK_VALUE;
            printf("{\"type\":\"reference-range\",\"role\":\"%s\",\"source\":%" PRIu64 ",\"destination\":%" PRIu64
                ",\"seq\":%u,\"ok\":%s,\"distance_cm\":", ROLE, result.source, result.destination,
                result.sequence, valid ? "true" : "false");
            if (valid) printf("%u", result.distance_cm); else printf("null");
            printf(",\"uptime_ms\":%" PRIu64 "}\n", now / 1000);
            result.pending = false;
            ++results;
        }
        if (!twr_in_progress() && now >= next_status) {
            identity(true);
            printf("{\"type\":\"reference-health\",\"results\":%" PRIu32 ",\"event_drops\":%" PRIu32
                ",\"result_overwrites\":%" PRIu32 ",\"exchange_resets\":%" PRIu32 "}\n",
                results, reference_event_drops(), overwritten, watchdog_resets);
            next_status = now + 5000000;
        }
        tight_loop_contents();
    }
}
