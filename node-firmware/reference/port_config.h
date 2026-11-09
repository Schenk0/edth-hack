#pragma once
#include "dwphy.h"

// Upstream embeds this constant in predicted TX timestamps. Use this physical
// module's saved TX delay, matching the delay written to the radio register.
extern uint16_t reference_tx_ant_delay;
#undef DWPHY_ANTENNA_DELAY
#define DWPHY_ANTENNA_DELAY reference_tx_ant_delay
