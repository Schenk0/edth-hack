# Three-node relative room demo

Firmware for Seeed Studio XIAO RP2350 boards connected to standard Qorvo DWM3000
modules. All boards use the same UF2. Saved node IDs, network and RF settings
make them N1, N2 or N3. The browser interface lives in `../demo/`.

The immediate demo is one room: N1 beside the Mac and N2/N3 placed elsewhere.
Each node exchanges real UWB ranges and computes its own position. The Mac
only displays reports. It does not solve coordinates or supply synthetic ranges.
The build, host suites and browser checks pass. All three boards run the room
firmware. A 45-second real capture through N2 received all three ranges and
positioned reports, with N1 powered away from Mac USB. Two subsequent stationary
triangles with tape references remained fresh throughout their settled windows,
but showed placement-dependent range bias from 2.75 to 72.7 cm. N3's 95th-percentile
position error was 70.7 to 84.1 cm. These trials establish data flow, not the desired
10 cm accuracy. Existing pair calibration is provisional; motion tracking and
room-wide performance remain unvalidated. See the [measured accuracy
record](calibration/room-accuracy-2026-11-08.json).

## What the map means

All three pairwise distances, N1–N2, N1–N3 and N2–N3, are required. The nodes
reconstruct a relative triangle using this explicit convention:

- N1 is `(0, 0)`.
- N2 lies on the positive x axis, at the measured N1–N2 distance.
- N3 uses the positive-y solution. Its x coordinate can be negative.

This determines a relative shape. The room's orientation and the true mirror
orientation remain unknown. The map is not aligned to walls, north or a surveyed
floor plan. Moving N2 also changes the axis used to describe the triangle.
Distance and position measurements have error; this is not an exact-coordinate
or calibrated-accuracy claim.

Every positioned report requires three fresh ranges. Missing/stale edges,
impossible triangles and poorly conditioned, nearly collinear arrangements
withhold coordinates. The minimum triangle altitude divided by its longest edge
must be at least 0.05. This is a provisional conditioning gate, not an accuracy
estimate. With only three distances there is no redundant geometric check that
can prove the ranges are unbiased.

The current USB firmware also emits a coherent `layout` record and advertises
`layout_version: 1`. All three vertices and the selected ranges come from one
solver call on the USB node. This prevents the display from mixing peer coordinates
computed with different measurement histories. The radio report protocol remains
wire version 2, so upgrading the Mac-connected node does not require flashing its
peers. Existing saved RF settings and calibration are retained. Transient radio
startup failures are retried once per second on configured nodes.

Separate optional [libdeca reference targets](reference/README.md) provide a pinned
third-party ranging implementation for controlled comparisons. Both targets
cross-build, but their RF operation has not yet been tested; the live demo still
uses the existing radio exchange.

## Prepared jitter-filter update

The current source filters each solver input using up to three unique range
samples younger than three seconds. It uses their median, or their rounded mean
when only two qualify. Raw USB measurements and radio gossip retain the original
values. Reports carry the age of the oldest input used; the existing six-second
expiry still applies. If independent edge histories produce an invalid triangle,
the solver uses the latest raw triangle only when that triangle is valid and fresh.

Offline replay through the actual C++ solver covers 12 saved observer streams.
All 690 local report slots remain positioned. This reduces stationary scatter
but does not correct the placement-dependent distance bias. Synthetic movement
steps take one second longer in the regularly sampled cases and up to 2.9 seconds
when updates pause. This update targets the stationary room demo; it does not
establish motion-tracking performance or 10 cm accuracy.

The candidate is built at `build-filtered/mesh-node.uf2`. A subsequent hardware
baseline/filter/baseline test kept the complete layout fresh in all six observer
recordings. On the same captured N2 inputs, the 95th-percentile jitter radius was
38.3 cm with raw C++ replay and 30.5 cm on the filtered hardware; all 60 filtered
positions matched replay within 1 mm. Median input age increased about 1.1 seconds.
Raw variation also changed between phases, so the phase comparison alone cannot
establish the filtering effect. Current geometry was not remeasured, and absolute
accuracy remains untested in this trial. See the
[hardware test record](calibration/filter-hardware-2026-11-08.json).

The tested update is active on all three nodes. N3's settings journal was backed
up before flashing; direct N2/N3 USB captures then verified fresh ranges and
positioned reports from all three nodes. N1 is on the power bank. Saved RF settings
and calibration are unchanged. See the
[N3 deployment record](calibration/node3-filter-deployment-2026-11-08.json).
Identity and the USB receiver's own reports advertise
`position_filter: "median3-3s"`; relayed reports omit this field because the wire
protocol does not carry filter provenance. See the
[offline verification record](calibration/jitter-filter-2026-11-08.json).

## Wiring

GPIO numbers refer to the RP2350, not the XIAO's printed D labels.

| DWM3000 signal | XIAO label | RP2350 GPIO |
|---|---|---|
| SCK | D8 | 2 |
| MOSI | D10 | 3 |
| MISO | D9 | 4 |
| CS / SPICSn | D0 | 26 |
| RSTn | D2 | 28 |
| IRQ | D1 | 27 |
| GND | GND | Common ground |
| Supply | 3V3 | Follow the module/breakout's supply requirements |

Use 3.3 V logic and supply, never the XIAO's 5 V pin. SPI0 runs at 2 MHz during
startup and 16 MHz afterward. Reset is driven low then released with a weak
pull-up; GPIO initialization alone preserves a pull-down that prevented earlier
bring-up. IRQ is an input; this polling implementation does not depend on it.
No external PA/LNA or RF switch is driven.

The defaults match Noah's soldering map. Change CS/RST/IRQ with CMake flags
`-DUWB_CS_PIN=26 -DUWB_RST_PIN=28 -DUWB_IRQ_PIN=27`. Existing build caches retain
old values, so pass them explicitly when updating an older build. Identity and
TEST output report the compiled assignments.

References: [Seeed pinout](https://wiki.seeedstudio.com/xiao_rp2350_arduino/),
[Qorvo DWM3000](https://www.qorvo.com/products/p/DWM3000).

## Build

Use CMake 3.20+, Ninja or Make, Python 3 and an Arm bare-metal toolchain with
newlib/C++ headers. The SDK is pinned to Pico SDK 2.2.0, and the Qorvo driver
source is pinned to `67dfbb7f2c5b1a4157b8c265b19f08776e91b1cc`.

From this folder:

```sh
sh scripts/fetch-sdk.sh
export PICO_TOOLCHAIN_PATH=/absolute/path/to/arm-gnu-toolchain
sh scripts/build.sh
```

Set `PICO_SDK_PATH` to reuse an SDK checkout. The toolchain must be
`arm-none-eabi`, not a Linux compiler. First configuration needs network access.
The shared output is `build/mesh-node.uf2`.

The physical flash capacity is 2 MB. A separate linker region reserves the last
8 KB for the persisted settings/boot journal. Keep `PICO_FLASH_SIZE_BYTES` at
2097152; reducing the SDK's physical flash limit previously prevented USB startup
when the boot journal was written.

## Installing and powering three boards with two Mac USB ports

Only one data connection is needed during the demo. Program the boards in turn.
Keep N1 on the Mac, and power N2/N3 from power banks or USB chargers. Check the
chosen power source before relying on untethered operation.

1. Back up a board's factory firmware before its first installation.
2. Flash the same room UF2 to each board. To enter BOOT mode manually, unplug
   USB, hold B, reconnect USB, then release B after two seconds.
3. Assign unique IDs N1, N2 and N3 and the same network, normally 60785.
4. Retain each physical module's own provisional RF/antenna settings. The prior
   pair's calibration does not calibrate a replacement or a new triangle.
5. Restart all nodes after reassigning physical boards to logical IDs, so cached
   boot generations from previous hardware cannot suppress the new reports.

Room firmware uses UWB wire version 2 and rejects the old version 1 line
firmware. Update all three boards before expecting a complete room layout.
Updating the UF2 preserves the journal's ID/network/RF settings. The old
`line_length_mm` storage field remains for compatibility but has no effect on
room geometry; no measured baseline is required for the relative map.

TX power defaults to `00000000`. The tested assemblies currently use
`fdfdfdfd`, the channel 5 setting from the
[Makerfabs example](https://github.com/Makerfabs/Makerfabs-ESP32-UWB-DW3000/blob/main/Dw3000/src/dw3000_config_options.cpp).
That setting restored early bring-up links, but is not a measured RF calibration.
Antenna-delay defaults of 16385 are also provisional. Do not infer calibration
from a saved register value or a passing chip self-test.

## USB monitor

```sh
sh scripts/monitor.sh
```

Open **http://127.0.0.1:5191** in Chrome or Edge. Connect one board using
**Connect USB node**. Web Serial reads the MCU directly; the local server only
serves static files and binds to loopback. Close other serial readers first.
Safari can replay recordings but does not support this USB connection flow.

The monitor displays the three node-reported x/y coordinates, all three range
histories and ages, and whether the complete relative layout is fresh. It shows
reflection/frame limitations rather than presenting the triangle as a room map.
The page never calculates missing positions. It withholds the map when required
ranges or positioned reports are stale or unavailable. Disconnecting USB marks
live observations unavailable immediately.

Configure the connected board's ID, network and RF settings in the settings
section. Saving changes reboots that board; reconnect afterward. Room settings
send zero for the reserved legacy baseline field. Recorded older line sessions
retain their legacy display. Recording replay cannot send configuration commands.
Sessions contain at most 10,000 serial lines; replay imports are capped at 20 MB.
No recordings are uploaded.

The USB CDC commands, at 115200 baud with DTR enabled, are:

```text
GET
TEST
HEALTH
SET 1 60785 0 16385 16385 0
REBOOT
```

SET has six decimal integers: ID, network, reserved baseline, TX delay, RX delay
and TX power register. The example uses provisional defaults, not a calibrated
profile. Settings save atomically. A newly flashed, unassigned N0 board keeps
its radio disabled. TEST checks raw device ID `deca0302`, driver initialization,
configuration and RX enable. An assigned node resumes radio operation afterward.
It does not establish RF reception or ranging accuracy. HEALTH checks live state
and 256 device-ID reads at 16 MHz and 2 MHz, restoring 16 MHz afterward; it
briefly delays packet handling and is for diagnostics.

## Measuring repeatability and accuracy

The clean [demo page](http://127.0.0.1:5192/) has **Details > Stationary
measurement**. Capture 60 seconds while the assemblies stay still; the first
five seconds are excluded from analysis. Leave the three tape fields blank to
measure repeatability. Fill all three with independent antenna-to-antenna
distances in metres to measure error against that reference triangle. No radio
settings, offsets or smoothing change when collecting or analyzing a recording.

When back at the hardware:

1. Check the assemblies' N1/N2/N3 labels. In the current setup N1 is the
   power-bank unit; the last connected demo board was N3. For an uncertain USB
   board, connect it alone and read its ID in the page header before labeling it.
2. Keep the broad triangle. Measure N1 to N2, N1 to N3 and N2 to N3 with a tape,
   using the same marked point on each module's antenna end. Enter metres,
   for example `1.420` for 142 cm. Leave their positions and orientation unchanged.
3. Step back, open **Details**, and click **Capture 60 seconds**. Keep the area
   still until capture finishes.
4. Click **Save measurement**. It includes the raw serial lines, reference
   distances and calculated metrics, so the result can be checked independently.

Range standard deviation describes repeatability, not error against the tape.
With a tape reference, median bias, RMSE and 95th-percentile absolute range error
describe the observed error. Node position errors compare the node-own reports
to the measured triangle in the same N1-origin/N2-axis convention. There is no
scale fitting or offset tuning. N1's zero position and N2's zero y coordinate are
imposed by that convention; they are not independent accuracy measurements.

The 95% jitter radius describes scatter around a node's median reported position.
The first/last shift compares median positions in the first and last thirds of
the capture; this short observation does not establish a long-term drift rate.
The live map translates all points around its USB node. If that node's calculated
position fluctuates, both other displayed markers move too. The measurement
tables use the canonical N1/N2 frame so that display translation does not obscure
the node-own coordinate statistics.

The analysis counts distinct fresh origin boot/sequence records, excludes
pre-settling payloads using their original age and USB queue delay, and includes
silence at the end in availability. Missing or inconsistent geometry remains
missing. Smoothing a plot would not validate its accuracy. A small sample or a
single placement cannot establish performance throughout the room or field.
New browser and `test-room.py` captures also compare wall time with the capture
clock. A difference over two seconds rejects the timing result and preserves the
raw recording, since Mac sleep can otherwise compress a long interruption into
apparently fresh data. Older recordings without wall time do not have this check.

Analyze a saved browser session or a `test-room.py` recording offline, with the
project's Node.js version:

```sh
node node-firmware/scripts/analyze-room.ts recording.json
node node-firmware/scripts/analyze-room.ts recording.json --distances 1.420 1.370 1.060 --out result.json
node --test demo/accuracy.test.ts
```

Those commands run from the repository root. `--distances` is ordered N1-N2,
N1-N3, N2-N3 and overrides any saved reference. Without a reference the output
contains repeatability metrics only. The analyzer never opens USB or sends
commands. Keep the raw recording and use another output path.

## Verification

```sh
sh scripts/test-host.sh
node --test tests/monitor.test.mjs
```

Host suites exercise the actual C++ geometry/protocol/cache and C journal under
ASan/UBSan, USB parsing, and bounded whole-line output under backpressure.
The browser test `tests/monitor-browser.mjs` uses a mocked Web Serial stream,
starts its own loopback server and closes it afterward. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to reuse an installed Chromium executable.

For a single radio's chip self-test, with pyserial installed:

```sh
python3 scripts/test-radio.py --port /dev/cu.usbmodem1101 --repeat 3
```

For the powered three-node room, connect one node to the Mac and use:

```sh
python3 scripts/test-room.py --port /dev/cu.usbmodem101 --seconds 25 --log .deps/room-session.json
```

This requires three fresh ranges and three fresh, correctly framed node-own
reports. A pass verifies ranging/report flow and an available relative layout,
not measured coordinate accuracy. Compare against independently measured room
positions after rotating/translating, and optionally reflecting, the reference
layout. Do not rescale ground truth or fit offsets separately to each placement.

The old `scripts/test-link.py` remains a two-node radio-link check. It cannot
validate a complete three-node room or locate two nodes in 2D.

## Protocol, freshness and diagnostics

Only the lower-ID endpoint initiates a pair. N1 alternates N2/N3; N2 initiates N3.
Other nodes respond. Exchanges use asymmetric double-sided TWR with hardware
TX scheduling, and the calculated delayed TX timestamp is checked against the
actual radio timestamp. Each node stores three origin-sequenced ranges and
forwards observations/reports while preserving age. No synchronized MCU clocks
are assumed. Nodes publish only their own coordinate solution.

Range and report payloads are not authenticated. Use a private experiment
network with trusted nodes. All cached ages and scheduling use 64-bit monotonic
time, while radio/wire timestamps and sequence arithmetic handle their stated
wrap periods. A six-second TTL applies; a solved report carries the oldest
contributing range's age. Expiry cannot revive old payloads at a 32-bit millis wrap.

JSON remains schema `v:1`. Room identity includes `geometry:relative-triangle`
and `wire_version:2`. Room reports use the coordinate frame
`relative-n1-n2-positive-y`, `reflection_ambiguous:true`, and `calibrated:false`.
Only `reference`/`relative` reports have coordinates. Missing inputs, inconsistent
ranges and poor geometry report null coordinates. `residual_m:null` means no
redundant geometric accuracy estimate is available from this triangle.

`radio-quality` links poll/response/final diagnostics to their exchange boot and
sequence, not the reporting board's own boot generation. It includes estimated
received and first-path powers and raw CIA quantities. Full CIA logging and its
SPI reads change receiver processing; these diagnostics are not a validated NLOS
classifier, uncertainty estimate or substitute for calibration.

USB uses eight bounded 512-byte formatted-line buffers and nonblocking 64-byte
writes. Overflow discards whole new lines; a partly sent line retains its suffix.
`usb_delay_ms` includes firmware queuing through the final write. Consumers add
that to age and host elapsed time. It does not measure delay in Mac USB buffers.
Disconnect discards the queue and the next connection begins with a line boundary.

## Physical evidence and known limits

The original 1D bring-up and controlled firmware A/B/A records are historical;
they do not validate the new room protocol or physical three-node positioning.
The [room deployment record](calibration/room-demo-deployment-2026-11-08.json)
tracks the installed image and preserved settings. A live two-node check correctly
withheld coordinates while the N1–N3 and N2–N3 ranges were missing.
A subsequent 30-second three-node capture ended with a complete relative layout,
but it was ready at only 144 of 251 checks taken every 100 ms after the first
five seconds. The placement was not surveyed or confirmed still. This verifies
functional three-node data flow, not coordinate accuracy.

Noah then confirmed a broad stationary triangle with the area clear. With the
same firmware and settings, a 45-second capture produced a complete layout within
1.6 seconds and passed all 401 freshness checks taken every 100 ms after the
first five seconds. All 136 received position reports had positioned statuses;
all 458 serial lines parsed without errors. The N2 radio counters recorded 69
successful exchanges and no failed exchanges during the counter interval.
The physical geometry was not surveyed, so this establishes availability in one
placement, not accuracy or the cause of the earlier intermittent result. N2's
reported x coordinate had 0.170 m sample standard deviation; N3's x/y had
0.096/0.061 m sample standard deviation. These are repeatability figures, not
errors against ground truth. Raw captures remain in
`.deps/device-backups/room-deployment/` and summaries are in the deployment record.
See [bring-up history](calibration/bringup-history.md),
[the firmware comparison](calibration/firmware-aba-2026-11-08.json), and
[raw timestamp replay](calibration/ranging-traces-2026-11-08.json).

That A/B/A experiment reproduced the exact historical original binary, preserved
RF settings and used equal settling/capture windows. The earlier large firmware
change did not reproduce, but all phases remained biased high at the stated
1.42 m separation. All 27 captured timestamp sets replayed through the actual
C++ distance function with identical integer-mm results. This checks arithmetic
and serialization, not physical timestamp-read correctness. The first-path power
gap is a clue, not an established cause. One earlier radio dropout required
reinitializing both radios; long-term recovery remains unvalidated.

The archived original/diagnostic images are in `.deps/experiments/firmware-aba/`.
The room source build is a new protocol and must not be described as the frozen
historical baseline. The repaired third radio passed three self-tests and joined
the real three-node exchange. Sustained power-bank operation, pair calibration,
RF bias, independent position accuracy and obstruction behavior need further tests.

The later [SPI/timestamp investigation](calibration/spi-timestamp-2026-11-08.json)
used a private instrumented image at actual 15, 7.5 and 15 MHz without restarting
between rate changes. That image completed no ranges, so it cannot establish an
SPI-rate effect on accuracy. The normal image was restored and its saved settings
verified on N2 and N3; their pair resumed ranging. N1 stopped being heard before
the final diagnostic phase and remained absent afterward. Its power/MCU/radio
state could not be distinguished remotely. Mac sleep also invalidated the
first baseline's elapsed-time comparison; the two earlier tape-reference captures
have matching host and node elapsed times. Raw evidence remains preserved.

N1 subsequently rejoined at boot 39. A [CRC on/off/on control](calibration/crc-isolation-2026-11-08.json)
isolated the diagnostic failure to the CRC-enabled path, including its additional
traffic and timing. With CRC off, raw timestamps and transmitted payloads replayed
consistently. This improved the investigation, not physical ranging accuracy.
A [same-image SPI-rate comparison](calibration/spi-rate-2026-11-08.json) at actual
15, 7.5 and 15 MHz without intervening restarts did not consistently reduce
scatter. A possible N1-N2 median shift remains unresolved in the short windows.
The normal firmware and unchanged calibration were restored on both USB nodes,
and all three nodes again supplied a complete layout. No production SPI or CRC
change was made. Original range bias remains unresolved.

A later [N2 transmit-power comparison](calibration/tx-power-2026-11-08.json)
used the normal firmware throughout, matched USB-node restarts and 60-second
measurement windows. Reducing N2's fine-gain setting changed N3's received-signal
readings, then restoring power reversed that change. N1-N2 range scatter remained
large. Original power and all saved fields were restored; this test did not
improve physical accuracy. N1's response-reception diagnostics were unavailable
while it ran from the power bank. A new measured layout with N1 on USB was
requested to observe that receiver.

With N1/N2 on Mac USB and N3 on the bank, a new measured triangle of
117/175/112 cm for pairs 12/13/23 remained fresh throughout both 60-second
settled observer windows. Median range errors were +9.2/-12.5/+2.8 cm. N3's
node-own 95th-percentile position error was 24.7 cm in the relative frame.
The [N1 receiver record](calibration/n1-receiver-2026-11-08.json) preserves both
observers and the independent accuracy analyses. Receiver-quality correlations
changed between temporal halves, so no quality correction was fitted. A second
placement with only N3 moved was requested to test whether these biases transfer
before considering a constant calibration.

## Future field target

The future goal remains neighbouring ground-resting units 25–50 m apart with
approximately 10 cm position error as an ideal. Units must work on grass or soil;
external stands cannot be required for a field acceptance test. A raised test
can diagnose RF effects but does not validate that deployment. Enclosure antenna
height, orientation and dry/damp conditions must be recorded. Measure range and
position error separately, including 95th-percentile error, availability and
recovery. This is a later target, not the room demo's current acceptance gate.

The pinned driver is licensed for use with Qorvo ICs. Retained SDK, driver and
TinyUSB notices are in [third-party/](third-party/); include them with binary
redistributions.
