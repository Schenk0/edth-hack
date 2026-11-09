#include "hardware/flash.h"
#include "pico/flash.h"
#include "settings.h"
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>

uint8_t test_flash[8192];
static int cut_program = -1, cut_erase = -1;
static jmp_buf power_loss;
static node_settings_t defaults = {0, 60785, 0, 16385, 16385, 0};
static uint32_t next_boot_generation(void) { node_settings_t s = defaults; return start_boot(&s); }
void flash_range_erase(uint32_t offset, size_t count) {
    assert(offset % FLASH_SECTOR_SIZE == 0 && offset + count <= sizeof(test_flash));
    for (size_t i = 0; i < count; ++i) {
        if ((int)i == cut_erase) longjmp(power_loss, 1);
        test_flash[offset + i] = 0xff;
    }
}
void flash_range_program(uint32_t offset, const uint8_t* data, size_t count) {
    assert(offset % FLASH_PAGE_SIZE == 0 && offset + count <= sizeof(test_flash));
    for (size_t i = 0; i < count; ++i) {
        if ((int)i == cut_program) longjmp(power_loss, 1);
        assert((test_flash[offset + i] & data[i]) == data[i]);
        test_flash[offset + i] &= data[i];
    }
}
int flash_safe_execute(void (*callback)(void*), void* context, unsigned timeout_ms) {
    (void)timeout_ms; callback(context); return PICO_OK;
}
static void interrupted_boot(bool erase, int cut) {
    uint8_t original[8192];
    memcpy(original, test_flash, sizeof(original));
    if (setjmp(power_loss) == 0) {
        if (erase) cut_erase = cut; else cut_program = cut;
        next_boot_generation();
        assert(!"Expected power interruption");
    }
    cut_erase = cut_program = -1;
    // A complete entry may have committed before interruption, so skipping a boot ID is allowed.
    const uint32_t recovered = next_boot_generation();
    assert(recovered >= 33 && recovered <= 34);
    assert(next_boot_generation() == recovered + 1);
    memcpy(test_flash, original, sizeof(original));
}
int main(void) {
    memset(test_flash, 0xff, sizeof(test_flash));
    for (uint32_t boot = 1; boot <= 32; ++boot) assert(next_boot_generation() == boot);
    for (int cut = 0; cut < 256; ++cut) interrupted_boot(false, cut);
    for (int cut = 0; cut < 4096; cut += 17) interrupted_boot(true, cut);
    for (uint32_t boot = 33; boot <= 120; ++boot) assert(next_boot_generation() == boot);
    const node_settings_t configured = {2, 42, 10000, 17000, 16000, 12345};
    assert(save_settings(&configured));
    node_settings_t loaded = defaults;
    assert(start_boot(&loaded) == 122);
    assert(memcmp(&loaded, &configured, sizeof(loaded)) == 0);
    // Interrupt every byte of a configuration write, not only the boot counter.
    uint8_t committed[8192]; memcpy(committed, test_flash, sizeof(committed));
    for (int cut = 0; cut < 256; ++cut) {
        const node_settings_t changed = {3, 99, 25000, 18000, 19000, 45678};
        if (setjmp(power_loss) == 0) {
            cut_program = cut; save_settings(&changed); assert(!"Expected interruption");
        }
        cut_program = -1; loaded = defaults;
        const uint32_t recovered = start_boot(&loaded);
        assert(recovered == 123 || recovered == 124);
        assert(memcmp(&loaded, recovered == 123 ? &configured : &changed, sizeof(loaded)) == 0);
        memcpy(test_flash, committed, sizeof(committed));
    }
    // Read the original firmware's boot-only entry without rolling its generation back.
    memset(test_flash, 0xff, sizeof(test_flash));
    const uint32_t legacy[4] = {0x4d4e4231u, 700, ~700u, 0x4d4e4231u ^ 700u ^ 0x7d19ac53u};
    memcpy(test_flash, legacy, sizeof(legacy));
    loaded = defaults;
    assert(start_boot(&loaded) == 701 && loaded.node_id == 0);
    puts("PASS: persistent boot generations, journal rollover and interrupted erase/program recovery");
}
