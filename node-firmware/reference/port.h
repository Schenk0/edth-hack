#pragma once
#include "settings.h"

bool reference_radio_init(const node_settings_t* settings);
void reference_poll(void);
void reference_restart_rx(void);
uint32_t reference_event_drops(void);
