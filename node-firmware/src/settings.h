#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif
// Stored atomically with the boot generation. node_id=0 keeps the radio disabled.
typedef struct {
    uint32_t node_id, network_id, line_length_mm, tx_ant_delay, rx_ant_delay, tx_power;
} node_settings_t;
static inline bool valid_settings(const node_settings_t* s) {
    return s->node_id <= 3 && s->network_id >= 1 && s->network_id <= 65535 &&
        s->line_length_mm <= 1000000 && s->tx_ant_delay <= 65535 && s->rx_ant_delay <= 65535;
}
uint32_t start_boot(node_settings_t* settings);
bool save_settings(const node_settings_t* settings);
#ifdef __cplusplus
}
#endif
