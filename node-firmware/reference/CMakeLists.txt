# Optional targets. The parent adds this directory after defining uwb_driver.
set(reference_vendor ${CMAKE_CURRENT_SOURCE_DIR}/vendor/libdeca)
add_library(mesh_reference_libdeca STATIC
  ${reference_vendor}/dwmac.c ${reference_vendor}/dwmac_irq.c
  ${reference_vendor}/dwphy.c ${reference_vendor}/dwtime.c
  ${reference_vendor}/ranging.c ${reference_vendor}/dwproto.c
  ${reference_vendor}/mac802154.c ${reference_vendor}/dwutil.c
  ${reference_vendor}/blink.c ${reference_vendor}/sync.c)
target_include_directories(mesh_reference_libdeca PUBLIC
  ${reference_vendor} ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_options(mesh_reference_libdeca PRIVATE
  "$<$<COMPILE_LANGUAGE:C>:-include;${CMAKE_CURRENT_SOURCE_DIR}/port_config.h>")
target_link_libraries(mesh_reference_libdeca PUBLIC uwb_driver m)

set(MESH_REFERENCE_PROCESSING_US 600 CACHE STRING "libdeca reference TWR processing delay in microseconds")
foreach(role initiator responder)
  set(reference_target mesh-reference-${role})
  add_executable(${reference_target} EXCLUDE_FROM_ALL
    main.c port.c ../src/boot.c)
  target_compile_definitions(${reference_target} PRIVATE
    REFERENCE_INITIATOR=$<STREQUAL:${role},initiator>
    REFERENCE_PROCESSING_US=${MESH_REFERENCE_PROCESSING_US}
    NETWORK_ID=${NETWORK_ID} UWB_CHANNEL=${UWB_CHANNEL}
    UWB_TX_POWER=${UWB_TX_POWER} UWB_TX_ANT_DELAY=${UWB_TX_ANT_DELAY}
    UWB_RX_ANT_DELAY=${UWB_RX_ANT_DELAY})
  target_compile_options(${reference_target} PRIVATE -Wall -Wextra -Werror)
  target_link_libraries(${reference_target} PRIVATE mesh_reference_libdeca
    pico_stdlib pico_unique_id hardware_flash pico_flash pico_rand)
  pico_set_linker_script(${reference_target} ${CMAKE_BINARY_DIR}/mesh_memmap.ld)
  pico_enable_stdio_usb(${reference_target} 1)
  pico_enable_stdio_uart(${reference_target} 0)
  pico_add_extra_outputs(${reference_target})
endforeach()
