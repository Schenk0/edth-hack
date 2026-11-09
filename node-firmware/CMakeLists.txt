cmake_minimum_required(VERSION 3.20)

set(PICO_BOARD seeed_xiao_rp2350 CACHE STRING "Target board")
# This is physical capacity for SDK flash bounds/QMI configuration, not a link limit.
set(PICO_FLASH_SIZE_BYTES 2097152 CACHE STRING "Physical flash capacity used by firmware")
if(NOT PICO_FLASH_SIZE_BYTES STREQUAL "2097152")
  message(FATAL_ERROR "Use -DPICO_FLASH_SIZE_BYTES=2097152; the journal occupies the last 8 KB of this region")
endif()
if(NOT DEFINED PICO_SDK_PATH)
  set(PICO_SDK_PATH "$ENV{PICO_SDK_PATH}")
endif()
if(NOT EXISTS "${PICO_SDK_PATH}/external/pico_sdk_import.cmake")
  message(FATAL_ERROR "Set PICO_SDK_PATH to Pico SDK 2.2.0; see README.md")
endif()
include(${PICO_SDK_PATH}/external/pico_sdk_import.cmake)
project(mesh_nodes C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
pico_sdk_init()
if(NOT PICO_SDK_VERSION_STRING STREQUAL "2.2.0")
  message(FATAL_ERROR "Use the pinned Pico SDK 2.2.0, or validate and update this firmware explicitly")
endif()

# Limit the application linker region separately, preserving the journal addresses.
math(EXPR MESH_APP_FLASH_SIZE "${PICO_FLASH_SIZE_BYTES} - 8192")
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/mesh_flash_region.ld
  "FLASH(rx) : ORIGIN = 0x10000000, LENGTH = ${MESH_APP_FLASH_SIZE}\n")
file(READ ${PICO_SDK_PATH}/src/rp2_common/pico_crt0/rp2350/memmap_default.ld mesh_memmap)
string(REPLACE "INCLUDE \"pico_flash_region.ld\"" "INCLUDE \"mesh_flash_region.ld\"" mesh_memmap "${mesh_memmap}")
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/mesh_memmap.ld "${mesh_memmap}")

set(LINE_LENGTH_MM 0 CACHE STRING "Legacy settings field; ignored by relative room geometry")
set(NETWORK_ID 60785 CACHE STRING "Private experiment ID, 1..65535")
set(UWB_CHANNEL 5 CACHE STRING "UWB channel: 5 or 9")
set(UWB_TX_POWER "0x00000000" CACHE STRING "Conservative initial TX power register; qualify on hardware")
set(UWB_TX_ANT_DELAY 16385 CACHE STRING "Uncalibrated initial TX antenna delay")
set(UWB_RX_ANT_DELAY 16385 CACHE STRING "Uncalibrated initial RX antenna delay")
set(UWB_CS_PIN 26 CACHE STRING "RP2350 GPIO, XIAO D0; soldered SPICSn")
set(UWB_RST_PIN 28 CACHE STRING "RP2350 GPIO, XIAO D2; soldered RSTn")
set(UWB_IRQ_PIN 27 CACHE STRING "RP2350 GPIO, XIAO D1; polling firmware")
if(NOT LINE_LENGTH_MM MATCHES "^[0-9]+$" OR LINE_LENGTH_MM GREATER 1000000)
  message(FATAL_ERROR "LINE_LENGTH_MM must be 0..1000000")
endif()
if(NOT NETWORK_ID MATCHES "^[0-9]+$" OR NETWORK_ID LESS 1 OR NETWORK_ID GREATER 65535)
  message(FATAL_ERROR "NETWORK_ID must be 1..65535")
endif()
if(NOT UWB_CHANNEL MATCHES "^(5|9)$")
  message(FATAL_ERROR "UWB_CHANNEL must be 5 or 9")
endif()

include(FetchContent)
FetchContent_Declare(decadriver
  GIT_REPOSITORY https://github.com/br101/dw3000-decadriver-source.git
  GIT_TAG 67dfbb7f2c5b1a4157b8c265b19f08776e91b1cc)
FetchContent_MakeAvailable(decadriver)
set(driver ${decadriver_SOURCE_DIR}/dwt_uwb_driver)
add_library(uwb_driver STATIC
  ${driver}/deca_interface.c ${driver}/deca_rsl.c
  ${driver}/dw3000/dw3000_device.c ${driver}/lib/qmath/src/qmath.c
  ${decadriver_SOURCE_DIR}/platform/deca_compat.c src/platform.c)
target_include_directories(uwb_driver PUBLIC ${driver} ${driver}/dw3000 ${driver}/lib/qmath/include
  ${decadriver_SOURCE_DIR}/platform src)
target_compile_definitions(uwb_driver PRIVATE CONFIG_DW3000_CHIP_DW3000=1 USE_DRV_DW3000=1)
target_compile_definitions(uwb_driver PUBLIC
  UWB_CS_PIN=${UWB_CS_PIN} UWB_RST_PIN=${UWB_RST_PIN} UWB_IRQ_PIN=${UWB_IRQ_PIN})
target_link_libraries(uwb_driver PUBLIC pico_stdlib hardware_spi hardware_sync)

option(MESH_BUILD_REFERENCE "Build separate vendor/library ranging reference firmware" OFF)
if(MESH_BUILD_REFERENCE)
  add_subdirectory(reference)
endif()

set(target mesh-node)
add_executable(${target} src/main.cpp src/radio.cpp src/mesh.cpp src/protocol.cpp src/boot.c src/setup.cpp src/json_output.cpp src/usb_output.cpp)
pico_set_linker_script(${target} ${CMAKE_CURRENT_BINARY_DIR}/mesh_memmap.ld)
target_include_directories(${target} PRIVATE src)
target_compile_definitions(${target} PRIVATE LINE_LENGTH_MM=${LINE_LENGTH_MM}
  NETWORK_ID=${NETWORK_ID} UWB_CHANNEL=${UWB_CHANNEL} UWB_TX_POWER=${UWB_TX_POWER}
  UWB_TX_ANT_DELAY=${UWB_TX_ANT_DELAY} UWB_RX_ANT_DELAY=${UWB_RX_ANT_DELAY})
target_compile_options(${target} PRIVATE -Wall -Wextra -Werror)
target_link_libraries(${target} PRIVATE uwb_driver pico_unique_id hardware_flash pico_flash pico_rand)
pico_enable_stdio_usb(${target} 1)
pico_enable_stdio_uart(${target} 0)
# USB is pumped by the foreground loop; JSON output bypasses lossy stdio writes.
target_compile_definitions(${target} PRIVATE PICO_STDIO_USB_ENABLE_IRQ_BACKGROUND_TASK=0
  "USBD_PRODUCT=\"Mesh node\"")
pico_add_extra_outputs(${target})
