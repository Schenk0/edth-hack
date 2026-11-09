# libdeca pair reference

Two optional firmware targets exercise libdeca's actual DS-TWR state machine on
the existing XIAO RP2350 + DWM3000 hardware:

- `mesh-reference-initiator` uses short address `0xa001` and ranges once a second.
- `mesh-reference-responder` uses short address `0xa002` and replies.

This is a separate comparison firmware. It does not produce mesh positions or
speak the room-demo wire protocol. The normal demo target is unchanged. These
targets have not been qualified on hardware; building them does not flash them.

## Build

From `node-firmware/`, with the usual SDK/toolchain environment, enable the
optional targets in a separate build directory and build them explicitly:

```sh
cmake -S . -B build-reference -DMESH_BUILD_REFERENCE=ON
cmake --build build-reference --target mesh-reference-initiator mesh-reference-responder
```

The UF2s are in `build-reference/reference/`. They use the same reserved-journal linker
region as the demo. Keep a copy of the known working demo UF2 before any later,
explicitly authorized comparison deployment.

Both targets cross-build and link with Pico SDK 2.2.0 and Arm GNU 14.2. The
generated RP2350 Arm-S UF2 blocks were checked for complete block numbering,
valid UF2 magic and payload addresses below the settings journal at `0x101fe000`.
This verifies the build artifacts; it does not establish RF operation or accuracy.

Both roles use the board's persisted network, TX power and separate TX/RX antenna
delays through the normal `start_boot` journal path. Boot appends a generation as
the normal firmware does. There is no settings command or role write; the saved
node ID is reported as `saved_node_id` and is never reassigned. An unassigned N0
board leaves its radio disabled. The role comes only from the selected UF2.

Compile-time channel and GPIO assignments come from the parent project. The radio
uses the demo's preamble 128, PAC8, code 9, IEEE 4a SFD, 6.8 Mbps and no STS.
The libdeca processing-delay argument defaults to its documented 600 microseconds;
set `MESH_REFERENCE_PROCESSING_US` at configure time to change it on both roles.
libdeca calculates the complete reply delay from this value and packet durations.
It does not use the demo's fixed reply delay or its range filter.

## Capture and comparison

Use one initiator and one responder with matching saved network and channel.
Power down other UWB nodes for the controlled pair capture. Keep antenna
orientation, placement, power source and tape reference unchanged between the
demo and reference captures. This isolates a pair; it does not validate the mesh.

USB CDC emits newline-delimited JSON at 115200 baud. Both nodes report
`reference-identity`, `reference-range` and `reference-health`. A valid range is
the library's integer `distance_cm`, without our median filter or an added offset.
`ok:false` with `distance_cm:null` represents the library's failure/status values.
The identity includes the exact library revision and effective RF settings.
Compare raw pair range bias, scatter and missing results against the same pair's
demo recording. Do not compare these records with filtered position coordinates.

Callbacks only copy results. USB output and formatting run outside the initiator's
active exchange. Event drops, result overwrites and a bounded exchange recovery
count are reported. The watchdog cancels a stuck initiator exchange after 250 ms;
the next attempt remains on the one-second schedule.

## Source and port

`vendor/libdeca/` contains unchanged source files from
[br101/libdeca](https://github.com/br101/libdeca/tree/226f3db3bc4ef2be9c143e8340a3851cd571cce9),
commit `226f3db3bc4ef2be9c143e8340a3851cd571cce9`. `vendor/SHA256SUMS` records their
downloaded bytes. The library is licensed under GNU LGPL version 3. Its complete
license text and GPL version 3 terms are included alongside the sources. Preserve
these notices and this source/build recipe with distributed reference binaries.

`port.c` implements the application-side hardware readiness and event-dispatch
hooks. It reuses `src/platform.c` through `uwb_driver` for SPI/reset and calls
Qorvo's `dwt_isr()` from the foreground. Callback events are copied into a bounded
queue before calling libdeca's handlers. The port does not enable a hardware ISR
or support radio sleep. USB library logging is disabled during exchanges.

`port_config.h`, force-included when compiling the library, replaces the upstream
`DWPHY_ANTENNA_DELAY` constant with the current board's saved TX delay. This is
necessary because libdeca includes that value in its predicted final TX timestamp.
The upstream files remain unchanged. The port initializes the radio itself and
sets libdeca's rate/preamble bookkeeping, rather than calling `dwphy_config`, which
would overwrite saved RF settings with library defaults. This remains libdeca's
exchange, MAC, timestamp conversion and distance calculation, with an explicit
Pico hardware adapter.

The existing Qorvo driver remains pinned by the parent project. Its separate
[Qorvo license](https://github.com/br101/dw3000-decadriver-source/blob/67dfbb7f2c5b1a4157b8c265b19f08776e91b1cc/dwt_uwb_driver/LICENSES/LicenseRef-QORVO-2.txt)
still applies. Qorvo's [DS-TWR examples and API guide, sections 6.3.26–27](https://forum.qorvo.com/uploads/short-url/xD3TlXKvkujjdUaJWXv2b4E7GQN.pdf)
describe the vendor reference exchange. These targets run libdeca, rather than
claiming to be unmodified Qorvo example firmware.
