# Historical bring-up record

This preserves the documentation before the three-node relative-room demo.
It describes superseded 1D firmware and calibration experiments. For the active
implementation, use [the firmware README](../README.md).

# XIAO RP2350 + DWM3000 mesh nodes

Standalone firmware for three Seeed Studio XIAO RP2350 boards, each connected to
one standard Qorvo DWM3000 module. Every board uses the same `mesh-node.uf2`;
node identity and experiment settings are saved over USB. All code and build output stay in this folder.

Each board runs its own measurement cache and localization. UWB carries ranging
exchanges, forwarded measurements and node reports. USB is an optional diagnostic
connection. No Wi-Fi, Bluetooth, phone, server or laptop is required to keep the
three nodes operating.

Implemented and cross-compiled for RP2350. **Physical USB, DWM3000 initialization,
N1-N2 ranging, report forwarding and a one-metre pair calibration have passed on
two assemblies.** Accuracy at other distances, long-term link reliability,
three-node localization and operation on a power bank still need validation.
This is prototype firmware, not a calibrated instrument.

## Immediate room-demo target

Noah narrowed the immediate demo to placing two nodes at arbitrary locations
within a single room and displaying their measured positions. The ground-level
25–50 m deployment below is a future target rather than the immediate demo gate.

The reference geometry must be explicit. Two stationary distance-only nodes
provide one separation and cannot determine their 2D positions in the room.
The phone prototype's two-node mode also uses bearing observations; the current
DWM3000 firmware supplies no bearings. Three nodes measuring all three pairwise
distances can recover a relative triangle, with translation, rotation and
reflection conventions stated. Room-referenced coordinates require additional
known references, bearing information or other independent geometric constraints.
Measured positions have error; exact coordinates are not a supported promise.

The current firmware below is still the ordered 1D bring-up experiment. A room
demo needs its own coordinate-frame definition, sufficient measurement links and
a suitable solver. The connected boards retain the frozen ranging baseline
while the node/reference count for this demo is clarified.

## Future field target

Noah's intended deployment has neighbouring nodes about **25–50 m apart**,
with position error as small as possible and **approximately 10 cm as the ideal**.
The finished units **must work lying directly on grass or soil**. External stakes,
stands or elevated installation cannot be required to meet this deployment target.
Any antenna clearance provided by the enclosure must be part of the ground-resting
unit itself. Required face/orientation tolerance and moisture exposure remain to
be defined and tested.
These are development targets, not demonstrated capabilities or a guaranteed
accuracy percentile. Pairwise ranging error and reconstructed position error
must be measured separately; the latter also depends on node geometry and the
available links. The current fixed-line experiment below does not implement
general field self-localization.

The next field validation should use a fixed firmware/settings baseline, the
actual ground-resting enclosure/antenna arrangement and independently measured
separations of 5, 10, 25 and 50 m, with one node on a power bank and the other
logging over USB. Begin with shorter ground-level links to establish a baseline.
Power-bank operation itself must be
checked first. Record median and 95th-percentile absolute range error, systematic
bias, exchange success rate, update rate and recovery after a blocked link or
restart. Calibration distances and held-out validation distances must be distinct.
Test grass and bare soil, dry and damp conditions, orientation and obstructions
one variable at a time. An elevated comparison can help diagnose ground effects,
but cannot count as validation of the required ground deployment. Measure actual
antenna height within the enclosure for reproducibility. Establish ground-level
range and accuracy before committing to the final antenna/module arrangement;
firmware changes alone are not assumed sufficient to meet the target.
Position-accuracy validation follows
once all-pair ranging and a general position solver are implemented.

## Supported experiment

The firmware explicitly models the ordered, straight, equal-height deployment
`N1 -> N2 -> N3`. N1 and N3 are references. N2 calculates its own position from
the measured N1-N2 and N2-N3 ranges and their endpoint baseline. N1-N3 packets
are rejected even if physically receivable, so endpoint observations and reports
must travel through N2. Forwarding and sensing currently use the same chain.

A newly flashed board starts unassigned, with its radio disabled. Assign its ID
in the USB dashboard. With a zero baseline, an assigned node performs real
ranging and forwarding but reports `unconfigured-line`, with null position.
Once the nodes are physically placed on a straight line, measure the N1-N3
separation and save that baseline on all three boards. No rebuild is needed.
N1 is `(0, 0)` and N3 is `(length, 0)` in a local metric frame.

For fresh adjacent ranges `a` and `b`, N2 fits `x=(a+length-b)/2`. It withholds a
position if either reference or range is missing, if `x` lies outside the declared
order, or if the per-edge residual `abs(a+b-length)/2` exceeds
`0.15 m + 5% * min(a,b)`. This provisional gate tests internal consistency;
it is not an accuracy estimate and cannot prove that the deployment is straight.
General 2D, bearings, moving references and arbitrary graph solving are unsupported.

## Wiring

These defaults follow Noah's supplied soldering map. Compare
against your assembly before flashing. Pin names below refer to RP2350 GPIO
numbers, not the D labels printed on the XIAO.

| DWM3000 signal | XIAO label | RP2350 GPIO |
|---|---|---|
| SCK | D8 | 2 |
| MOSI | D10 | 3 |
| MISO | D9 | 4 |
| CS / SPICSn | D0 | 26 |
| RSTn | D2 | 28 |
| IRQ | D1 | 27 |
| GND | GND | Common ground |
| Supply | 3V3 | Follow the exact breakout/module power requirements |

Use 3.3 V logic. Do not apply 5 V to a bare module's supply or signal pins.
The SPI driver starts at 2 MHz and switches to 16 MHz after initialization.
RSTn is driven low then released as an input with a weak pull-up, never driven high.
This replaces the RP2350 pad's default pull-down. Ensure the
assembly provides the reset pull-up required by its module/breakout. WAKEUP is
unused; ensure it has the appropriate inactive level for your board. IRQ is
configured as an input but events are polled, so IRQ is optional for this version.
No external PA/LNA or custom RF switch is driven.

SCK/MOSI/MISO are fixed to SPI0. CS, RST and IRQ can be changed through CMake,
with `-DUWB_CS_PIN=26 -DUWB_RST_PIN=28 -DUWB_IRQ_PIN=27`. Keep these distinct from
each other and SPI pins. Existing build directories retain old CMake cache values;
pass these flags explicitly when updating an older checkout. Identity and TEST
output include the compiled GPIO assignments to make mismatches visible.

References: [Seeed pinout](https://wiki.seeedstudio.com/xiao_rp2350_arduino/),
[DWM3000 documentation](https://www.qorvo.com/products/p/DWM3000).

## Build

Requirements: Git, CMake 3.20+, a native build tool such as Ninja or Make,
Python 3, and an Arm bare-metal toolchain with newlib and C++ headers.
Verified here with Arm GNU Toolchain 14.2.Rel1, CMake 4.4.4 and Ninja.
Arm publishes [toolchain downloads](https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads).
Use the `arm-none-eabi` variant, not a Linux-targeting compiler.

From this folder:

```sh
sh scripts/fetch-sdk.sh
export PICO_TOOLCHAIN_PATH=/absolute/path/to/arm-gnu-toolchain
sh scripts/build.sh
```

`PICO_TOOLCHAIN_PATH` names the toolchain directory containing `bin/`.
Alternatively put its `bin/` on PATH. Set `PICO_SDK_PATH` to use an existing
SDK checkout. `fetch-sdk.sh` pins SDK 2.2.0 and initializes TinyUSB. CMake fetches
the driver at the pinned commit on its first run. The SDK fetches its UF2 helper,
picotool, when required. First configuration therefore needs network access.

The single output is `build/mesh-node.uf2`. Flash this identical image onto all
three boards, then configure each board over USB. The older `node1.uf2`,
`node2.uf2` and `node3.uf2` images are superseded.

`UWB_CHANNEL` defaults to 5; channel 9 is configurable at build time. SPI wiring
is also configured at build time. Node ID, network ID, baseline, antenna delays
and TX power are runtime settings stored in flash. CMake values for those
settings only supply defaults on a board without saved configuration. Updating
the UF2 preserves saved settings.

## USB test dashboard

From this folder:

```sh
sh scripts/monitor.sh
```

Open **http://127.0.0.1:5191** in Chrome or Edge on the Mac. Click **Connect USB
node** and select the board labeled **Mesh node**. The page uses Web Serial directly, so there is no
serial bridge, package install or cloud service. The local Python server serves
static files only and binds to loopback. Safari does not provide this USB flow;
the page also supports recording replay without Web Serial. Close any other
serial monitor using the same board first.

The dashboard displays node-reported positions, adjacent ranges with recent
history, age, hop counts, boot generations and gateway diagnostics. Positions
and checks become stale after six seconds; disconnecting USB immediately marks
live data unavailable. Two-hop verification requires connecting an endpoint,
N1 or N3, while all three boards are powered. The expected N2 position field is
an independent measurement used only to show error. The Mac never solves.

**Configure connected board** saves settings only to the board attached over
USB. Assign a unique ID, and use the same network and measured baseline on every
board. Use 0 m until ready for straight-line localization. Saving settings
restarts the connected board. Click Connect USB node again after it reappears.
A repeated save with unchanged settings avoids a flash write and restart.
If reassigning IDs between previously used boards, restart all nodes afterward
to clear cached boot generations for the previous assignments.
Setup remains available when the radio fails to initialize, so calibration or
experiment configuration can still be corrected.

Antenna delays default to 16385 and are uncalibrated placeholders. TX power
starts at `00000000`, the lowest register gain settings. Use measured per-board
calibration and qualified RF settings for the module, channel and region.
Calibration values can differ between boards. The page does not mark a board
physically calibrated just because settings were entered.

During physical N1-N2 testing, the zero-gain setting produced no usable link at
roughly one metre. Both tested boards now have `fdfdfdfd` saved, matching the
channel 5 TX configuration in the
[Makerfabs DWM3000 example](https://github.com/Makerfabs/Makerfabs-ESP32-UWB-DW3000/blob/main/Dw3000/src/dw3000_config_options.cpp).
This is a bring-up setting, not a measured RF power calibration. New boards still
default to zero; configure their RF settings explicitly before testing the link.

**Save session** downloads serial lines with their receipt timing as JSON.
**Open recording** replays that file, clearly labeled as recorded data; no USB
commands can be sent during replay. The page keeps the latest 10,000 lines,
shows how many earlier lines were discarded and caps imports at 20 MB. Paused
or finished replay freezes recorded time for inspection. Live data always ages
with elapsed time. No recordings are uploaded. The raw USB log is available
under the diagnostics disclosure.

For a terminal instead of the dashboard, open USB CDC at 115200 baud and send:

```text
GET
TEST
HEALTH
SET 1 60785 10000 16385 16385 0
REBOOT
```

`SET` takes six decimal integers: node ID, network ID, baseline in millimeters,
TX antenna delay, RX antenna delay and the TX power register. The example assigns
N1 and a **10 m baseline**, which must match the physical measurement before use.
`GET` prints identity/settings. `TEST` reads the raw radio device ID, initializes
the driver, configures the radio and checks RX enable. It returns `radio-test`
with `ok`, `device_id` and `stage`. On an unassigned board it leaves the radio
idle after testing; it does not assign an ID, save settings or send ranging
packets. On an already running node it reinitializes and resumes that node's
radio. A passing self-test does not validate RF reception or distance accuracy.
`HEALTH` samples live system status/state and checks 256 device-ID reads each at
16 MHz (`fast_errors`) and 2 MHz (`slow_errors`), restoring 16 MHz afterward.
It requires a running radio, changes no settings and does not reset the radio.
Run it only for diagnostics: its SPI reads briefly delay normal packet handling.

For repeatable Mac-side checks, with pyserial installed in your Python environment:

```sh
python3 scripts/test-radio.py --repeat 3 --log .deps/radio-self-test.json
```

The script exits nonzero unless all attempts return `deca0302` and `ready`.
Use `--port /dev/cu.usbmodem1101` if more than one mesh board is attached. Close
the dashboard's USB connection first so the port is free.

With N1 and N2 both connected to USB and their antennas unobstructed:

```sh
python3 scripts/test-link.py --seconds 15 --log .deps/link-test.json
```

This reads both streams simultaneously without changing settings. It requires
at least three matching fresh direct ranging exchanges on both nodes and exits
nonzero otherwise. Old counters and forwarded observations cannot satisfy the
check. Passing proves packet exchange, not calibrated distance accuracy.

Invalid, partial and oversized commands are
rejected without writing. Successful `SET` commits all values atomically before
restarting. There are no remote configuration commands over the radio.

## First board and subsequent bring-up

1. Confirm the exact wiring and breakout. Hold BOOT while connecting USB or
   pressing RESET, then copy `build/mesh-node.uf2` to the bootloader drive. This
   replaces the firmware on that board. Repeat the same image for all boards.
2. Start the dashboard and connect the first board. It initially reports an
   unassigned ID and does not transmit. Assign N1, network 60785 and baseline
   0. Save, wait for restart and reconnect. Set the other two boards to N2 and N3
   in the same way. Do not assign the same ID twice.
3. A lone assigned board has no successful ranges. A second adjacent node should
   produce measurements. `radio-init-failed-check-wiring` includes a `stage`
   describing the failed step. The supported device ID is `deca0302`.
4. Measure several known pairwise distances at fixed antenna orientation and
   height. Save sessions, characterize bias/repeatability and tune each board's
   antenna delays before interpreting localization accuracy.
5. Power all three boards and keep N1 connected to the Mac. Check that N1 sees
   N3's report with two hops through N2, and that both ranges are fresh.
6. Place nodes in order on a straight line at equal antenna height. Measure
   N1-N3 and save that baseline on **all three boards**, connecting each over USB.
   Keep N1 attached afterward. Compare N2's own position with an independent
   measurement entered in the dashboard.
7. Disconnect the USB display. Nodes should continue. Reconnect to inspect
   reports. Power off N2: remote reports and measurements should expire after
   six seconds. Restart it and check recovery. References keep their explicitly
   configured coordinates, even while disconnected from the rest of the mesh.

The firmware makes no USB-drive access or flash/upload attempts from the build
scripts. There is no live radio control until an image is installed on a board.

### Replacing a physical board

A replacement takes the missing logical ID. With N1 still operating and N2
removed for repair, the third physical board should be assigned N2 so the
existing pair test continues to work. The shared UF2 remains identical.
Start the new module with its own provisional antenna delays, run TEST, then
validate and calibrate the new pair. The removed module's calibration record
does not establish calibration for its replacement.

Restart the surviving nodes after assigning the replacement. Boot generations
are stored per physical board, so a new board using an existing ID may start
below the previous board's cached generation. A restart clears those caches
while preserving saved settings. Recheck fresh reports and ranges afterward.

## Radio and mesh behavior

Only the lower-ID endpoint initiates a pair. N1 ranges N2; N2 ranges N3; N3
responds. Each initiator waits a randomized 650..1249 ms between attempts.
Asymmetric double-sided two-way ranging uses poll, response, final and result
messages. Response and final use hardware delayed TX, 2000 UWB microseconds
after reception. The predicted antenna-adjusted TX timestamp is checked against
the hardware timestamp before the exchange is accepted. Each receive wait is
bounded. Unrelated packets can be dropped during an exchange; gossip repeats.
Random retry timing avoids requiring a shared clock but cannot eliminate radio
collisions. This three-node prototype has no general MAC scheduler.

Distances use six measured TX/RX timestamps and the standard asymmetric DS-TWR
formula. Timestamp differences handle low-word wrap and reject intervals above
20 ms, invalid distances and failed transmissions. No synthetic bearing is
attached. Multipath and NLOS bias remain possible even for CRC-valid frames.

Four fixed cache slots hold two anchors and two ranges. Records carry origin,
boot generation, sequence, age and hops. New origin boots invalidate that
origin's old records; duplicates never refresh age. Forwarding adds elapsed
local buffer time plus a 2 ms allowance per hop. Records expire at six seconds
and stop forwarding after four hops. The transport is short-address IEEE
802.15.4 framing with hardware FCS and a versioned binary application payload.
Only adjacent-node unicast packets in this experiment are accepted. It has no
authentication, encryption, STS or hostile-peer protection.

Boot generations and complete USB settings live in an append-only two-sector
flash journal, with a versioned format and checksum.
The application is linked below `0x1fe000`, with journals in `0x1fe000..0x1fffff`,
within a conservative 2 MB physical flash allocation. `PICO_FLASH_SIZE_BYTES`
must remain 2097152 for the SDK's flash bounds and QMI setup. The application
linker region is limited separately to 2088960 bytes. A regular UF2 update leaves
the journal sectors intact. Do not change this layout or reuse those sectors
without migrating the journal. A full-chip erase resets the generation and
requires restarting the other nodes, which otherwise correctly reject older
generations. Journal rollover erases the other sector first. Interrupted writes
retain either the complete previous configuration or the complete new one; no
partial configuration is applied. The original boot-only journal is migrated
without rolling its generation back. Old per-node firmware IDs were compiled
in, so assign an ID over USB after upgrading from that version.

## Serial output and phone-code reuse

Output is newline-delimited JSON with schema `v:1`:

- `identity`: node ID, unique hardware ID, boot, network, baseline and RF settings.
  N0 means unassigned. `setup_version:1` enables dashboard configuration.
- `setup`: command acknowledgment or a validation/storage error.
- `radio-test`: raw radio device ID and initialization outcome from `TEST`.
- `radio-health`: live status/state and SPI read error counts from `HEALTH`.
- `radio-quality`: latest received poll/response/final signal diagnostics, keyed
  by exchange boot/sequence. Includes estimated total/first-path power in dBm,
  raw CIR power and first-path amplitudes, accumulation count, DGC decision,
  first-path index in Q10.6, capture time and receive status. Use only
  `valid:true` values and include `age_ms` plus USB delay when checking freshness.
  These are diagnostics, not an automatic obstruction classifier or accuracy
  estimate. The dashboard preserves the raw lines; the solver does not use them.
- `measurement`: accepted range/anchor, origin boot/sequence, age and hop count.
  `value_mm` means distance for a range or local x for an anchor.
- `report`: origin node's own computed status, position or null, consistency
  residual and age. A USB-connected node also prints reports forwarded from peers.
- `diagnostics`: accepted/rejected record counts, radio/ranging counters and
  `usb_dropped`, the number of complete lines discarded when the queue fills or
  USB is disconnected. `rx_frames` counts poll, response, final, result,
  observation and report packets in that order. `initiate_stage` and
  `respond_stage` identify where the most recent exchange stopped.
  `decode_errors` also counts valid packets addressed to a different node.
  With only N1 and N2 powered, N2's attempts to range N3 are expected to fail.
- `error`: boot-journal or radio initialization failure.

USB output uses a fixed queue of eight lines, each up to 511 formatted bytes.
Formatting overflow and queue overflow discard whole new lines. A partially
transmitted line stays queued until it is complete; it cannot lose its suffix
because the host pauses reading. USB is pumped in the foreground between radio
exchanges, in chunks of at most 64 bytes, without waiting for host capacity.
On disconnect, queued output is discarded and a newline starts the next stream.
Physically disconnecting mid-line can still leave a fragment on the old host
connection; the dashboard's line parser recovers at the next newline.

Every JSON line includes `usb_delay_ms`, measured through the final transmission
chunk. Consumers must add this queue delay to `age_ms` and elapsed time since
receipt. The dashboard and recording replay already do so, preventing queued
telemetry from appearing fresh after the host resumes. This measures firmware
queue delay, not additional delay inside the Mac's USB/OS buffers.

Local receipt timestamps and scheduling use the Pico's 64-bit monotonic clock.
Expired measurements and reports cannot become fresh again at the 32-bit
millisecond boundary. Origin sequence high-water marks remain after expiry.

Only `reference` and `located` reports have coordinates. Reports are never used
as solver inputs. `calibrated:false` is intentional until physical calibration
and validation have been completed. Report consumers must advance `age_ms` after
receipt and expire remote reports; the serial stream does not emit a separate
deletion event for expired remote reports.

This ports the phone core's origin/sequence, duplicate suppression, age-preserving
forwarding and per-node computation rules. The binary wire format and serial
schema are firmware-specific, with integer millimeters and monotonic boot IDs.
They are not directly accepted by the existing browser. A future serial bridge
must translate them to the browser's measurement/report schema, map uptime/age
to its timestamp conventions and expose this distance-only line solver mode.
The hardware dashboard reads the firmware schema directly. The native iPhone
adapter, Nearby Interaction token exchange and bearing solver are not reused.

## Verification

```sh
sh scripts/test-host.sh
```

Host C/C++ tests run the actual mesh, wire codec, solver, TWR calculation and
flash-journal implementation with AddressSanitizer and UndefinedBehaviorSanitizer.
They cover three-node forwarding, loss of fresh measurements, boot replacement,
stale/duplicate rejection, expiry beyond multiple 32-bit uptime periods, radio
timestamp wrap, clock skew,
inconsistent geometry, disabled default localization, malformed packet mutations
and journal recovery after interrupted erase/program operations. USB queue tests
model a 64-byte CDC FIFO plus a 64-byte in-flight endpoint, a stalled host,
whole-line overflow and recovery. Node also parses the actual queued output
through the dashboard validator, so host checks require Node as well as C/C++.

On 8 November 2026, the shared firmware was flashed and verified on a physical
XIAO RP2350 with 2 MB flash. USB enumeration as “Mesh node”, complete JSON identity
messages, the GET command, software REBOOT and a persisted boot counter advancing
from 1 to 2 were verified. The board remained unassigned with the radio disabled;
this does not validate the DWM3000 connection or ranging.

DWM3000 bring-up then passed after matching the supplied soldering map
(CS GPIO26, reset GPIO28, IRQ GPIO27) and releasing reset with a weak pull-up.
GPIO initialization alone preserves the RP2350 pad's reset-state pull-down,
which had prevented communication even after the pin assignments were corrected.
The physical module returned device ID `deca0302` and passed driver initialization
and RX enable three times, followed by ten successful repetitions after a software
restart. Identity and TEST logs include the actual compiled GPIO assignments and
the reset line level. This initial test verified chip communication and
initialization; both boards were subsequently assigned N1 and N2.

A second physical RP2350 was backed up, flashed and configured as N2 on the same
network. Its DWM3000 passed three self-tests. With both boards connected over
USB, repeated device-ID reads passed at both 16 MHz and 2 MHz. Neither radio
produced usable packets at zero transmit gain, including with SPI held at 2 MHz.
Changing only saved TX power to `fdfdfdfd` restored N1-N2 ranging and bidirectional
report forwarding. A 15-second capture recorded 15 matching fresh ranges on both
ends, 1.181–1.375 m, at the user's approximately one-metre placement. After
restoring 16 MHz SPI, a further 30-second capture recorded 29 matching fresh
ranges on both ends and 30 remote reports per node. Its ranges varied from
0.693–1.458 m, so these results establish a functioning link, not distance
accuracy or calibration. Those link tests used the uncalibrated 16385 antenna delays.

A subsequent pair calibration used an operator-measured 1 m antenna separation.
Early trials varied while people moved nearby. With the area clear, both radios
initially stopped delivering packets despite passing SPI checks. Running TEST on
both restored the link without changing settings; the cause of that dropout
remains unresolved. Do not infer long-term reliability from the short captures.

The final **TX and RX antenna delays are 16387 on both N1 and N2**, saved in flash
and verified after their automatic restarts. With the area still clear, a fresh
45-second check captured 44 matching direct exchanges on both boards: median
1.013 m, sample standard deviation 0.0156 m, minimum 0.981 m, maximum 1.039 m.
The medians of the two halves were 1.0145 m and 1.0115 m. This passed the chosen
one-metre check: at least 25 shared exchanges, median error at most 25 mm,
at least 80% within 100 mm and half-sample median difference at most 50 mm.
These are acceptance thresholds for this prototype check, not accuracy guarantees.

Settings, original delays and capture summaries are in
[the pair calibration record](../calibration/n1-n2-2026-11-08.json).
The original delays were 16385 on both boards. This calibrates the combined
N1-N2 offset at one distance and orientation. Independent per-board corrections
require an additional reference or measurements involving the third board.
Validate at another measured distance before relying on positioning accuracy.
Reports retain `calibrated:false`; complete per-node/network calibration has not
been validated.

The subsequent 1.80 m antenna-to-antenna check failed with those saved settings:
43 matching exchanges had median 2.084 m and sample standard deviation 0.0215 m.
Radio reinitialization without a settings change produced 26 more matching
exchanges with median 2.0815 m. The operator confirmed the measurement reference
but reported that module orientation may have changed. A controlled orientation
repeat was not completed before N2 was removed for repair. The one-metre result does not establish accuracy at other
distances or orientations; the saved calibration has not been retuned to hide
this failed check.

That N2 assembly was then removed for repair. The third physical RP2350 board,
`88E80DCAE67A7A54`, was backed up and installed as replacement N2. Its DWM3000
passed three initialization self-tests with the same wiring. After assigning
N2 and restarting N1 to clear the previous peer's cached generations, a fresh
15-second link check captured 16 matching direct exchanges, with remote reports
received in both directions. Replacement N2 started at TX/RX delays of 16385.
At an operator-measured 1 m separation with the photo-confirmed placement, 38
fresh matching exchanges had median 0.853 m and sample standard deviation
0.0282 m. Holding N1's TX/RX delays fixed at 16387, replacement N2's TX/RX
delays were reduced by 31 DTU to **16354** and saved in flash.

A separate 40-second check after N2's automatic restart recorded 40 matching
exchanges: median 0.9965 m, mean 1.0006 m, sample standard deviation 0.0304 m,
minimum 0.931 m and maximum 1.061 m. Both half-sample medians were 0.9965 m.
This passes the same one-metre acceptance thresholds described above. It is a
combined pair correction, not independent per-module calibration.

The operator then provided a 1.42 m separation for the holdout check. With the
saved delays unchanged, 39 matching exchanges had median 1.751 m, sample standard
deviation 0.1784 m and range 1.508–2.267 m. This **failed** the same acceptance
criteria. The pair is not validated across placements.

Signal-quality logging was then enabled on both boards. A separate 25-second
diagnostic capture at 1.42 m produced 25 matching ranges with median 1.537 m and
sample standard deviation 0.0185 m, still too long. Median total/first-path powers
were about -80.7/-91.8 dBm for N1's responses and -80.2/-90.0 dBm for N2's finals.
That power gap supports investigating reflections and mounting, but does not
establish the cause. Repeated device-ID reads passed at 16 MHz and 2 MHz on both
boards; CIA completion was present in every sampled reception. Diagnostic reads
took at most 201 us and produced no TX errors in this capture.

The diagnostic firmware enables full CIA logging and reads quality before RX
restart. It reports the pinned Qorvo fixed-point power estimates using explicit
Ipatov code 9, avoiding incorrect code extraction in that driver's convenience
power wrappers. Diagnostic logging changes CIA processing and adds SPI reads,
so its capture is not identical to the original holdout firmware. No antenna
delay or RF power changes were made to fit the failed holdout. Antenna/tabletop
mounting is the next controlled physical check; raising the assemblies was
deferred because the operator cannot do that in the current setup. Accuracy across distances,
orientations and obstructions remains unverified for the replacement pair.
Its settings and checks are in
[the replacement pair record](../calibration/n1-n2-replacement-2026-11-08.json).
The earlier pair record is historical and does not calibrate the new assembly.

A later controlled firmware comparison kept the replacement pair at the
operator-confirmed 1.42 m separation and froze all saved settings. Rebuilding
the pre-quality source reproduced the recorded historical original UF2 SHA256
exactly (`55caa6cb…`). That sealed image was compared against the archived
diagnostic image (`a7bcf115…`) in an original → diagnostic → original sequence.
Both boards were restarted before each phase, followed by 15 seconds of settling
with USB continuously drained and two consecutive 25-second captures.

The pooled medians were 1.557 m, 1.5485 m and 1.5545 m respectively, with sample
standard deviations of 0.0190 m, 0.0180 m and 0.0216 m. N1's failed-attempt
counter deltas were 1/51, 1/53 and 0/50. N2's attempts toward the absent N3 are
excluded. These counter intervals and matching-result capture windows have
different boundaries, so their counts need not be identical. No USB-drop or
TX-error counter increments occurred within the six windows.
The earlier large median/spread change did not reproduce. This small experiment
does not prove equivalence or exclude small/intermittent firmware effects; all
phases still read about 13 cm long. Matching results at both boards are delivery
agreement for the same responder-computed distance, not independent measurements.
See [the controlled comparison record](../calibration/firmware-aba-2026-11-08.json).

A separate original-based trace image then buffered the full local 40-bit
poll/response/final timestamps at both endpoints and the initiator's transmitted
low-word timestamps at the responder. Output was queued only after each exchange
returned, with no additional radio SPI reads. All 27 paired traces matched the
transmitted values, and host replay through the actual `mesh.cpp::twr_distance`
function reproduced all 27 reported integer-millimetre results. This verifies
arithmetic and serialization for those samples, not physical timestamp accuracy
or SPI timestamp-read integrity. Both source variants have the same experimental
trace instrumentation prepared for any future component-isolation comparison.
The [raw timestamp replay record](../calibration/ranging-traces-2026-11-08.json)
preserves the six inputs and full local timestamps.

**Both boards were restored to the exact original pre-quality image after this
experiment**, preserving N1 delays 16387, replacement N2 delays 16354, network
60785, zero baseline and TX power `fdfdfdfd`. The default source build and
`build/mesh-node.uf2` still contain the diagnostic implementation; the sealed
comparison images and experimental harness are in `.deps/experiments/firmware-aba/`.
The next decision is to hold the original configuration fixed and test mounting
or surroundings when repositioning is possible, without retuning offsets to fit
each placement. The first-path/total-power gap remains a clue, not a confirmed
explanation, and distance accuracy remains unvalidated across placements.

The shared image has been cross-compiled for RP2350. The USB command parser and
atomic settings migration/recovery run in the host tests. The dashboard model
tests run with `node --test tests/monitor.test.mjs`. The browser test
`tests/monitor-browser.mjs` uses the repository's Playwright dependency and an
explicitly mocked USB stream; it checks setup, reports, stale data, disconnect,
session export/replay and responsive layout. It starts and closes its own
temporary loopback server. Physical two-node packet exchange and ranging have
passed as described above. Multi-distance and per-module calibration, obstruction
behavior, long-term link reliability, a third node, three-node localization and
continued operation without USB remain unverified.

Pinned driver source:
[br101/dw3000-decadriver-source at 67dfbb7](https://github.com/br101/dw3000-decadriver-source/tree/67dfbb7f2c5b1a4157b8c265b19f08776e91b1cc).
Its Qorvo code is licensed for Qorvo ICs. Retained driver, SDK and TinyUSB license
notices are in [third-party/](../third-party/); include these with binary distributions.
