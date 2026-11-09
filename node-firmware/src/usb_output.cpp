#include "usb_output.hpp"
#include "json_output.hpp"
#include "pico/stdlib.h"
#include "pico/stdio_usb.h"
#include "tusb.h"

static mesh::JsonOutput output;
static bool need_boundary = true;
void usb_logf(const char* format, ...) {
    va_list arguments; va_start(arguments, format);
    output.vformat(time_us_64() / 1000, format, arguments);
    va_end(arguments);
}
// Background tud_task is disabled. USB work happens only in the foreground,
// outside radio exchanges; no stdio out_chars call can silently drop a suffix.
void usb_log_poll() {
    tud_task();
    if (!stdio_usb_connected()) { output.clear(); need_boundary = true; return; }
    if (need_boundary) {
        if (tud_cdc_write_available() && tud_cdc_write("\n", 1) == 1) need_boundary = false;
    } else {
        const auto bytes = output.next(time_us_64() / 1000, tud_cdc_write_available());
        if (!bytes.empty()) output.consume(tud_cdc_write(bytes.data(), static_cast<uint32_t>(bytes.size())));
    }
    tud_cdc_write_flush();
}
void usb_log_finish(uint32_t timeout_ms) {
    const auto until = make_timeout_time_ms(timeout_ms);
    while (!time_reached(until)) { usb_log_poll(); sleep_ms(1); }
}
uint32_t usb_log_dropped() { return output.dropped; }
