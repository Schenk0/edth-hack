#pragma once
#include <stdbool.h>
#define PICO_OK 0
int flash_safe_execute(void (*callback)(void*), void* context, unsigned timeout_ms);
