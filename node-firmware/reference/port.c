#include "port.h"
#include "deca_device_api.h"
#include "dwhw.h"
#include "dwmac.h"
#include "dwphy.h"
#include "platform/dwmac_task.h"
#include "pico/stdlib.h"
#include <string.h>

extern void uwb_platform_init(void);
extern void uwb_platform_fast(void);
extern uint32_t uwb_platform_device_id(void);
extern struct dwt_probe_s uwb_probe;
extern struct txbuf* current_tx;

uint16_t reference_tx_ant_delay;
static bool ready;
struct event {
    enum dwevent_e type;
    union { struct rxbuf rx; uint32_t status; } data;
};
static struct event events[8];
static unsigned read_index, write_index;
static uint32_t dropped;

bool reference_radio_init(const node_settings_t* settings) {
    uwb_platform_init();
    if (uwb_platform_device_id() != 0xdeca0302 || dwt_probe(&uwb_probe) != DWT_SUCCESS) return false;
    const absolute_time_t deadline = make_timeout_time_ms(100);
    while (!dwt_checkidlerc()) {
        if (time_reached(deadline)) return false;
        sleep_us(100);
    }
    if (dwt_initialise(DWT_DW_INIT) != DWT_SUCCESS) return false;
    uwb_platform_fast();
    dwt_config_t config = {
        UWB_CHANNEL, DWT_PLEN_128, DWT_PAC8, 9, 9, DWT_SFD_IEEE_4A,
        DWT_BR_6M8, DWT_PHRMODE_STD, DWT_PHRRATE_STD, 129,
        DWT_STS_MODE_OFF, DWT_STS_LEN_64, DWT_PDOA_M0,
    };
    if (dwt_configure(&config) != DWT_SUCCESS) return false;
    dwt_txconfig_t tx = {UWB_CHANNEL == 5 ? 0x34 : 0x38, settings->tx_power, 0};
    dwt_configuretxrf(&tx);
    reference_tx_ant_delay = settings->tx_ant_delay;
    dwt_settxantennadelay(settings->tx_ant_delay);
    dwt_setrxantennadelay(settings->rx_ant_delay);
    // libdeca uses these values to calculate reply delays and RX timeouts.
    // Its own dwphy_config() would replace the saved RF settings, so skip it.
    dwphy_set_plen(DWT_PLEN_128);
    dwphy_set_rate(DWT_BR_6M8);
    ready = true;
    return true;
}

// Run Qorvo's ISR from the foreground, then deliver copied callback events.
// Neither SPI nor libdeca runs from a hardware interrupt on this Pico port.
void reference_poll(void) {
    dwt_isr();
    while (read_index != write_index) {
        const struct event event = events[read_index];
        read_index = (read_index + 1) % 8;
        switch (event.type) {
        case DWEVT_RX: dwmac_handle_rx_frame(&event.data.rx); break;
        case DWEVT_RX_TIMEOUT: dwmac_handle_rx_timeout(event.data.status); break;
        case DWEVT_TX_DONE:
            dwmac_handle_tx_done();
            // A report has no expected response. Return the responder to RX
            // after libdeca releases that TX buffer so the next poll is heard.
            if (!current_tx) dwt_rxenable(DWT_START_RX_IMMEDIATE);
            break;
        case DWEVT_ERR: dwmac_handle_error(event.data.status); break;
        }
    }
}
int dwtask_init(void) { return 0; }
int dwtask_queue_event(enum dwevent_e type, const void* data) {
    const unsigned next = (write_index + 1) % 8;
    if (next == read_index) { ++dropped; return -1; }
    struct event* event = &events[write_index];
    event->type = type;
    if (type == DWEVT_RX) memcpy(&event->data.rx, data, sizeof(event->data.rx));
    else if (type == DWEVT_RX_TIMEOUT || type == DWEVT_ERR) memcpy(&event->data.status, data, sizeof(event->data.status));
    write_index = next;
    return 0;
}
bool dwhw_is_ready(void) { return ready; }
void dwhw_enable_tx_interrupt(bool on) {
    dwt_setinterrupt(DWT_INT_TXFRS_BIT_MASK, 0, on ? DWT_ENABLE_INT : DWT_DISABLE_INT);
}
void dwhw_sleep_after_tx(void) { panic("Reference firmware does not support radio sleep"); }
void reference_restart_rx(void) {
    dwt_forcetrxoff();
    dwt_setrxtimeout(0);
    dwt_setpreambledetecttimeout(0);
    dwt_writesysstatuslo(SYS_STATUS_ALL_RX_ERR | SYS_STATUS_ALL_RX_TO | DWT_INT_RXFCG_BIT_MASK | DWT_INT_TXFRS_BIT_MASK);
    dwt_rxenable(DWT_START_RX_IMMEDIATE);
}
uint32_t reference_event_drops(void) { return dropped; }
