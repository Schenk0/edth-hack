#pragma once
#include <inttypes.h>

// Keep USB and formatting out of timestamp-sensitive library callbacks.
#define LOG_ERR(...) ((void)0)
#define LOG_WARN(...) ((void)0)
#define LOG_INF(...) ((void)0)
#define LOG_DBG(...) ((void)0)
#define LOG_ERR_IRQ(...) ((void)0)
#define LOG_INF_IRQ(...) ((void)0)
#define LOG_DBGL_TS(...) ((void)0)
#define LOG_HEXDUMP(...) ((void)0)
#define DBG_UWB(...) ((void)0)
#define DBG_UWB_IRQ(...) ((void)0)
