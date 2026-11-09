#pragma once
#include <cstdint>

void usb_logf(const char* format, ...) __attribute__((format(printf, 1, 2)));
void usb_log_poll();
void usb_log_finish(uint32_t timeout_ms);
uint32_t usb_log_dropped();
