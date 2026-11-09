#include "deca_device_api.h"
#include "deca_interface.h"
#include "hardware/spi.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"

// Single-core, polling driver. RSTn is open drain: drive low, then release.
void uwb_platform_init(void) {
    gpio_init(UWB_CS_PIN); gpio_put(UWB_CS_PIN, 1); gpio_set_dir(UWB_CS_PIN, GPIO_OUT);
    gpio_init(UWB_RST_PIN); gpio_put(UWB_RST_PIN, 0); gpio_set_dir(UWB_RST_PIN, GPIO_OUT);
    sleep_ms(2);
    // gpio_init preserves the pad pull-down; released RSTn needs a high level.
    gpio_pull_up(UWB_RST_PIN);
    gpio_set_dir(UWB_RST_PIN, GPIO_IN);
    sleep_ms(5);
    gpio_init(UWB_IRQ_PIN); gpio_set_dir(UWB_IRQ_PIN, GPIO_IN);
    spi_init(spi0, 2000000);
    gpio_set_function(2, GPIO_FUNC_SPI); gpio_set_function(3, GPIO_FUNC_SPI); gpio_set_function(4, GPIO_FUNC_SPI);
    spi_set_format(spi0, 8, SPI_CPOL_0, SPI_CPHA_0, SPI_MSB_FIRST);
}
static void slow(void) { spi_set_baudrate(spi0, 2000000); }
static void fast(void) { spi_set_baudrate(spi0, 16000000); }
void uwb_platform_fast(void) { fast(); }
void uwb_platform_slow(void) { slow(); }
static void wakeup(void) { gpio_put(UWB_CS_PIN, 0); sleep_us(600); gpio_put(UWB_CS_PIN, 1); sleep_ms(5); }
static int32_t read_spi(uint16_t hl, uint8_t* h, uint16_t length, uint8_t* data) {
    gpio_put(UWB_CS_PIN, 0);
    spi_write_blocking(spi0, h, hl); spi_read_blocking(spi0, 0, data, length);
    gpio_put(UWB_CS_PIN, 1); return DWT_SUCCESS;
}
uint32_t uwb_platform_device_id(void) {
    uint8_t header = 0, bytes[4];
    read_spi(1, &header, sizeof(bytes), bytes);
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
        ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}
static int32_t write_spi(uint16_t hl, const uint8_t* h, uint16_t length, const uint8_t* data) {
    gpio_put(UWB_CS_PIN, 0);
    spi_write_blocking(spi0, h, hl); spi_write_blocking(spi0, data, length);
    gpio_put(UWB_CS_PIN, 1); return DWT_SUCCESS;
}
static int32_t write_crc(uint16_t hl, const uint8_t* h, uint16_t length, const uint8_t* data, uint8_t crc) {
    gpio_put(UWB_CS_PIN, 0);
    spi_write_blocking(spi0, h, hl); spi_write_blocking(spi0, data, length); spi_write_blocking(spi0, &crc, 1);
    gpio_put(UWB_CS_PIN, 1); return DWT_SUCCESS;
}
decaIrqStatus_t decamutexon(void) { return save_and_disable_interrupts(); }
void decamutexoff(decaIrqStatus_t state) { restore_interrupts(state); }
void deca_sleep(unsigned int ms) { sleep_ms(ms); }
void deca_usleep(unsigned long us) { sleep_us(us); }
static struct dwt_spi_s spi_functions = {
    .readfromspi = read_spi, .writetospi = write_spi, .writetospiwithcrc = write_crc,
    .setslowrate = slow, .setfastrate = fast,
};
static const struct dwt_driver_s* drivers[] = { &dw3000_driver };
struct dwt_probe_s uwb_probe = {
    .dw = NULL, .spi = &spi_functions, .wakeup_device_with_io = wakeup,
    .driver_list = (struct dwt_driver_s**)drivers, .dw_driver_num = 1,
};
