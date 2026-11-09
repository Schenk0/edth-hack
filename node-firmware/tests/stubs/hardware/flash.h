#pragma once
#include <stddef.h>
#include <stdint.h>
extern uint8_t test_flash[8192];
#define XIP_BASE ((uintptr_t)test_flash)
#define FLASH_SECTOR_SIZE 4096u
#define FLASH_PAGE_SIZE 256u
#define PICO_FLASH_SIZE_BYTES 8192
void flash_range_erase(uint32_t offset, size_t count);
void flash_range_program(uint32_t offset, const uint8_t* data, size_t count);
