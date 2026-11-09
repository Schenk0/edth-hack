#include "settings.h"
#include "hardware/flash.h"
#include "pico/flash.h"
#include <stddef.h>
#include <string.h>

// A new journal format preserves the old boot counter while adding atomic settings.
#define JOURNAL_OFFSET (PICO_FLASH_SIZE_BYTES - 2 * FLASH_SECTOR_SIZE)
#define OLD_MAGIC 0x4d4e4231u
#define MAGIC 0x4d4e4232u
struct entry { uint32_t magic, generation; node_settings_t settings; uint32_t checksum; };
struct latest { uint32_t generation, offset; node_settings_t settings; };
struct operation { uint32_t offset; uint8_t* page; bool erase; };

static uint32_t checksum(const struct entry* e) {
    const uint8_t* bytes = (const uint8_t*)e;
    uint32_t hash = 2166136261u;
    for (size_t i = 0; i < offsetof(struct entry, checksum); ++i) hash = (hash ^ bytes[i]) * 16777619u;
    return hash;
}
static struct latest scan(const node_settings_t* defaults) {
    const uint8_t* base = (const uint8_t*)(XIP_BASE + JOURNAL_OFFSET);
    struct latest result = {0, 0, *defaults};
    for (uint32_t offset = 0; offset < 2 * FLASH_SECTOR_SIZE; offset += FLASH_PAGE_SIZE) {
        struct entry e;
        memcpy(&e, base + offset, sizeof(e));
        if (e.magic == MAGIC && e.generation && e.checksum == checksum(&e) && valid_settings(&e.settings)) {
            if (e.generation > result.generation) result = (struct latest){e.generation, offset, e.settings};
        } else if (e.magic == OLD_MAGIC) {
            uint32_t old[4]; memcpy(old, base + offset, sizeof(old));
            if (old[1] && old[2] == ~old[1] && old[3] == (OLD_MAGIC ^ old[1] ^ 0x7d19ac53u) && old[1] > result.generation)
                result = (struct latest){old[1], offset, *defaults};
        }
    }
    return result;
}
static void write_page(void* argument) {
    struct operation* op = argument;
    if (op->erase) flash_range_erase(op->offset & ~(FLASH_SECTOR_SIZE - 1u), FLASH_SECTOR_SIZE);
    flash_range_program(op->offset, op->page, FLASH_PAGE_SIZE);
}
static uint32_t append(const struct latest* previous, const node_settings_t* settings) {
    if (!valid_settings(settings) || previous->generation == UINT32_MAX) return 0;
    const uint8_t* base = (const uint8_t*)(XIP_BASE + JOURNAL_OFFSET);
    uint32_t offset = previous->generation ? previous->offset + FLASH_PAGE_SIZE : 0;
    bool erase = !previous->generation || offset % FLASH_SECTOR_SIZE == 0;
    offset %= 2 * FLASH_SECTOR_SIZE;
    // Skip incomplete pages without ever erasing the sector holding the latest commit.
    while (!erase && offset % FLASH_SECTOR_SIZE) {
        bool empty = true;
        for (size_t i = 0; i < FLASH_PAGE_SIZE; ++i) if (base[offset + i] != 0xff) empty = false;
        if (empty) break;
        offset += FLASH_PAGE_SIZE;
        if (offset % FLASH_SECTOR_SIZE == 0) { erase = true; offset %= 2 * FLASH_SECTOR_SIZE; }
    }
    uint8_t page[FLASH_PAGE_SIZE]; memset(page, 0xff, sizeof(page));
    struct entry e = {MAGIC, previous->generation + 1, *settings, 0};
    e.checksum = checksum(&e); memcpy(page, &e, sizeof(e));
    struct operation op = {JOURNAL_OFFSET + offset, page, erase};
    if (flash_safe_execute(write_page, &op, 1000) != PICO_OK || memcmp(base + offset, &e, sizeof(e))) return 0;
    return e.generation;
}
uint32_t start_boot(node_settings_t* settings) {
    const struct latest previous = scan(settings);
    *settings = previous.settings;
    return append(&previous, settings);
}
bool save_settings(const node_settings_t* settings) {
    const struct latest previous = scan(settings);
    return append(&previous, settings) != 0;
}
