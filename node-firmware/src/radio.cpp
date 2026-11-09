#include "radio.hpp"
#include "pico/stdlib.h"
#include <limits>
extern "C" {
#include "deca_device_api.h"
#include "deca_rsl.h"
#include "dw3000_deca_regs.h"
void uwb_platform_init(void);
void uwb_platform_fast(void);
void uwb_platform_slow(void);
uint32_t uwb_platform_device_id(void);
extern struct dwt_probe_s uwb_probe;
}

namespace mesh {
static uint64_t timestamp(bool tx) {
    uint8_t p[5];
    if (tx) dwt_readtxtimestamp(p); else dwt_readrxtimestamp(p, DWT_COMPAT_NONE);
    uint64_t value = 0;
    for (unsigned i = 0; i < 5; ++i) value |= uint64_t(p[i]) << (8 * i);
    return value;
}
bool Radio::init() {
    init_error = "spi-probe-failed";
    uwb_platform_init();
    device_id = uwb_platform_device_id();
    if (device_id != 0xdeca0302) return false;
    if (dwt_probe(&uwb_probe) != DWT_SUCCESS) return false;
    device_id = dwt_readdevid();
    init_error = "unsupported-device-id";
    if (device_id != 0xdeca0302) return false; // Standard DW3110 in DWM3000.
    const auto deadline = make_timeout_time_ms(100);
    init_error = "idle-rc-timeout";
    while (!dwt_checkidlerc()) { if (time_reached(deadline)) return false; sleep_us(100); }
    init_error = "driver-initialization-failed";
    if (dwt_initialise(DWT_DW_INIT) != DWT_SUCCESS) return false;
    uwb_platform_fast();
    dwt_config_t config = {
        UWB_CHANNEL, DWT_PLEN_128, DWT_PAC8, 9, 9, DWT_SFD_IEEE_4A,
        DWT_BR_6M8, DWT_PHRMODE_STD, DWT_PHRRATE_STD, 129,
        DWT_STS_MODE_OFF, DWT_STS_LEN_64, DWT_PDOA_M0,
    };
    init_error = "radio-configuration-failed";
    if (dwt_configure(&config) != DWT_SUCCESS) return false;
    dwt_txconfig_t tx = {static_cast<uint8_t>(UWB_CHANNEL == 5 ? 0x34 : 0x38), settings.tx_power, 0};
    dwt_configuretxrf(&tx);
    dwt_settxantennadelay(settings.tx_ant_delay); dwt_setrxantennadelay(settings.rx_ant_delay);
    dwt_configciadiag(DW_CIA_DIAG_LOG_ALL);
    signal = {};
    dwt_setrxaftertxdelay(100); dwt_setrxtimeout(0);
    init_error = "rx-enable-failed";
    if (!listen()) return false;
    init_error = "ready";
    return true;
}
void Radio::stop() { dwt_forcetrxoff(); }
Radio::Health Radio::health() {
    Health h{dwt_readsysstatuslo(), dwt_read_reg(SYS_STATE_LO_ID), 0, 0};
    for (unsigned i = 0; i < 256; ++i) h.fast_errors += uwb_platform_device_id() != 0xdeca0302;
    uwb_platform_slow();
    for (unsigned i = 0; i < 256; ++i) h.slow_errors += uwb_platform_device_id() != 0xdeca0302;
    uwb_platform_fast();
    return h;
}
bool Radio::listen() {
    dwt_forcetrxoff();
    dwt_writesysstatuslo(SYS_STATUS_ALL_RX_ERR | SYS_STATUS_ALL_RX_TO | DWT_INT_RXFCG_BIT_MASK | DWT_INT_TXFRS_BIT_MASK);
    return dwt_rxenable(DWT_START_RX_IMMEDIATE) == DWT_SUCCESS;
}
void Radio::capture_quality(const Frame& frame, uint32_t status) {
    const auto started = time_us_64();
    dwt_cirdiags_t diag{};
    SignalQuality q;
    q.peer = frame.source; q.boot = frame.boot; q.seq = frame.seq;
    q.rx_status = status;
    q.received_ms = started / 1000;
    if (dwt_readdiagnostics_acc(&diag, DWT_ACC_IDX_IP_M) == DWT_SUCCESS) {
        q.dgc = dwt_get_dgcdecision();
        q.power = diag.power; q.f1 = diag.F1; q.f2 = diag.F2; q.f3 = diag.F3;
        q.accum_count = diag.accumCount; q.fp_index_q6 = diag.FpIndex;
        // Our PHY uses Ipatov code 9 (64 MHz PRF). Pass it explicitly because
        // the pinned driver's convenience wrappers extract the code incorrectly.
        q.rssi_q8 = rsl_calculate_signal_power(diag.power, 21, diag.accumCount, q.dgc, 9, false);
        q.first_path_q8 = rsl_calculate_first_path_power(diag.F1, diag.F2, diag.F3, diag.accumCount, q.dgc, 9, false);
        q.valid = diag.accumCount && diag.power && q.dgc <= 7 &&
            q.rssi_q8 != std::numeric_limits<int16_t>::min() &&
            q.first_path_q8 != std::numeric_limits<int16_t>::min();
    }
    q.read_us = static_cast<uint32_t>(time_us_64() - started);
    signal[static_cast<size_t>(frame.type)] = q;
}
std::optional<Reception> Radio::poll() {
    const uint32_t status = dwt_readsysstatuslo();
    if (status & (SYS_STATUS_ALL_RX_ERR | SYS_STATUS_ALL_RX_TO)) {
        last_rx_error = status;
        ++rx_errors; listen(); return {};
    }
    if (status & DWT_INT_RXFCG_BIT_MASK) {
        const uint64_t received_at = timestamp(false);
        uint8_t ranging_bit = 0;
        const uint16_t length = dwt_getframelength(&ranging_bit);
        uint8_t bytes[127];
        std::optional<Frame> frame;
        if (length >= 2 && length <= sizeof(bytes)) {
            dwt_readrxdata(bytes, length - 2, 0); // Hardware verified FCS, excluded here.
            frame = decode_frame(bytes, length - 2, id_);
        }
        if (frame && frame->type <= Message::final) capture_quality(*frame, status);
        listen();
        if (frame) { ++received_frames[static_cast<size_t>(frame->type)]; return Reception{*frame, received_at}; }
        ++rx_errors; ++decode_errors;
    }
    return {};
}
// Delayed TX has 512-DTU resolution. Returned timestamp includes TX antenna delay.
uint64_t Radio::delayed_time(uint64_t received_at) {
    return (((received_at + 2000ull * 65536) & ~511ull) + settings.tx_ant_delay) & 0xffffffffffull;
}
bool Radio::send(const Frame& f, std::optional<uint64_t> delayed_at, uint64_t* actual_tx) {
    uint8_t bytes[127]{};
    const size_t length = encode_frame(f, bytes, sizeof(bytes) - 2);
    if (!length) return false;
    dwt_forcetrxoff();
    dwt_writesysstatuslo(DWT_INT_TXFRS_BIT_MASK | SYS_STATUS_ALL_RX_ERR | SYS_STATUS_ALL_RX_TO | DWT_INT_RXFCG_BIT_MASK);
    dwt_writetxdata(length, bytes, 0);
    dwt_writetxfctrl(length + 2, 0, f.type <= Message::result ? 1 : 0);
    uint8_t mode = DWT_START_TX_IMMEDIATE | DWT_RESPONSE_EXPECTED;
    if (delayed_at) {
        dwt_setdelayedtrxtime(static_cast<uint32_t>((*delayed_at - settings.tx_ant_delay) >> 8));
        mode = DWT_START_TX_DELAYED | DWT_RESPONSE_EXPECTED;
    }
    if (dwt_starttx(mode) != DWT_SUCCESS) { ++tx_errors; listen(); return false; }
    const auto deadline = make_timeout_time_ms(8);
    while (!(dwt_readsysstatuslo() & DWT_INT_TXFRS_BIT_MASK)) {
        if (time_reached(deadline)) { ++tx_errors; listen(); return false; }
        tight_loop_contents();
    }
    const uint64_t actual = timestamp(true);
    dwt_writesysstatuslo(DWT_INT_TXFRS_BIT_MASK);
    if (actual_tx) *actual_tx = actual;
    if (delayed_at && actual != *delayed_at) { ++tx_errors; listen(); return false; }
    return true;
}
}
