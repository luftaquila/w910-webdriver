# W910 protocol reference

- Scope: USB HID wire format and W910 product mappings.
- Client: [W910 WebDriver](README.md).
- Audience: independent interoperable implementations.
- Evidence: static analysis, captured vendor traffic, and direct hardware readback.
- Excluded: vendor binaries and extracted resources.

## Device identity

- USB manufacturer: `YXT`
- USB product: `K100 Keyboard`
- BLE name: `SXS-W910BT`
- USB version: `2.0`
- Device release: `0x0100`
- MCU firmware: `2.3.0001` (read-only command `F0`, selector `1`)
- Firmware custom/build ID: `K2008-250612` (`F0`, selector `2`)
- Dongle firmware: `2.3.0000` through the receiver (`F1`, selector `1`)
- Serial number: none
- Known vendor IDs: `0x36A4`, `0xB6A4`
- Wired product ID: `0x4100`
- 2.4 GHz receiver product ID: `0x4101`

USB composite interfaces:

| Interface | Collections |
| ---: | --- |
| 0 | Boot mouse |
| 1 | Boot keyboard |
| 2 | Consumer, System Control, vendor `FF00`, vendor `FF01`, additional keyboard report |

Configuration collection:

- Usage page: `0xFF01`
- Usage: `0x0001`
- Feature Report ID: `0x06`
- Feature payload: 40 bytes
- Total report size including report ID: 41 bytes
- Report descriptor fragment: `0601ff0901a10185060921150026ff0075089528b102c0`

## Transports

USB:

- Send the common 41-byte frame with `SetFeature`.
- Receive a read response with `GetFeature`.
- WebHID passes report ID `0x06` separately, so browser code sends the remaining 40 bytes.
- The macOS bridge sends the same HID `SET_REPORT`/`GET_REPORT` requests as raw USB control transfers on interface 2.
- Raw request fields: `bmRequestType 21/A1`, `bRequest 09/01`, `wValue 0306`, `wIndex 0002`.

BLE protocol reconstruction:

- Service UUID: `0000fff0-0000-1000-8000-00805f9b34fb`
- Configuration characteristic: `0000fff1-0000-1000-8000-00805f9b34fb`
- Battery service: `0x180F`
- Battery level characteristic: `0x2A19`
- The vendor application converts its hex text back to raw bytes and writes the same complete 41-byte common frame to FFF1.
- Read responses arrive through FFF1 notifications or indications; characteristic reads are also supported.
- Writes use response mode when the characteristic advertises it, otherwise write-without-response.
- W910 WebDriver uses the same frame codec for WebHID and Web Bluetooth.
- Initial Web Bluetooth authorization requires the keyboard to be advertising.
- Pairing advertisement: no service UUID list; manufacturer data `06 00 03 00 80` (`companyIdentifier=0x0006`, payload prefix `03 00 80`).
- W910 WebDriver filters on the captured manufacturer data and grants FFF0 separately through `optionalServices`.
- W910 WebDriver retains the selected `BluetoothDevice` for advertisement-free reconnects during the current page lifetime.
- W910 WebDriver reuses authorized devices through `navigator.bluetooth.getDevices()` when the browser exposes that experimental API; Chrome 150 does not expose it by default.
- Chrome 150 on macOS does not add a system-connected, non-advertising W910 BLE peripheral to the `requestDevice()` chooser.
- Physical CoreBluetooth validation: FFF1 exposes read, write-without-response, and notify; its measured maximum write is 43 bytes.
- Physical transaction validation: the 41-byte status request returned battery 99, and a 300-second sleep setting passed unchanged write/readback.

2.4 GHz:

- Receiver identity: `B6A4:4101`, vendor collection `FF01:0001`.
- The receiver carries the same 41-byte feature-report protocol as wired USB.
- Read responses are available after approximately 20 ms.
- Direct profile reads and configuration writes are supported while the keyboard is switched to `2.4G`.
- Physical validation: full settings read plus unchanged sleep-timeout write/readback.

## Common frame

- Multibyte address byte order: little-endian.

| Offset | Size | Meaning |
| ---: | ---: | --- |
| 0 | 1 | Report ID, always `06` |
| 1 | 1 | Fixed `00` |
| 2 | 1 | Fixed `01` |
| 3 | 1 | Command |
| 4 | 1 | Sequence number, incremented for each request |
| 5 | 1 | Selector |
| 6..7 | 2 | Address, little-endian |
| 8 | 1 | Data length, `0..32` |
| 9..40 | 32 | Data followed by zero padding |

Properties:

- Maximum data per frame: 32 bytes.
- Read command: write command with bit 7 set.
- Read transaction: send the read-request through `SetFeature`, wait approximately 20 ms, then call `GetFeature`.
- Read-request byte 8 contains the requested length; its data area is zero-filled.
- No checksum.
- No encryption.
- No compression.
- No transaction/commit packet.

Captured write changing the physical B key to keyboard A:

```text
06 00 01 04 00 00 20 00 04 02 04 00 00 00 ...
               ^^       ^  ^^^^^^^^^^^
               layer    |  action 02 04 00 00
                        address 0x0020
```

## Command map

| Write | Read | Selector / address | Data |
| ---: | ---: | --- | --- |
| `02` | `82` | selector `1`, address `slot*2` | Per-slot generation token, 16-bit big-endian |
| `02` | `82` | selector `2`, address `0` | Selected onboard slot, `0` or `1` |
| `02` | `82` | selector `3`, address `0` | Sleep timeout in seconds, uint16 little-endian |
| `02` | `82` | selector `4`, address `0` | Power-down timeout in seconds, uint16 little-endian |
| `04` | `84` | selector `0` Normal, `1` Fn | Main action bank |
| `05` | `85` | selector `0` Normal, `1` Fn | Scroll action bank |
| `08` | `88` | selector = macro slot | Macro stream, address = byte offset |
| `09` | `89` | selector `0` | Lighting header or mode record |
| — | `81` | selector `0`, address `0` | Three-byte device status |
| — | `F0` | selector `1`, address `0` | Eight-byte ASCII MCU firmware version |
| — | `F0` | selector `2`, address `0` | Sixteen-byte ASCII custom/build identifier |
| — | `F1` | selector `1`, address `0` | Eight-byte dongle firmware version field |

Additional generic DevDock queries seen in the binary/probe:

- `83`: report-rate family; not exposed by the W910 UI.
- `82` selectors `5`, `6`, and `7`: generic global/charge fields; not required by the W910 UI.
- Generic mouse DPI, polling, and LOD commands exist in the shared application framework but have no confirmed W910 product meaning.
- Open implementations should not write these dormant commands without product-specific evidence.

## Status and timeouts

Command `81`, three-byte response:

- Byte 0: vendor wireless connection/presence state.
- Wired byte 0: normally `00`; USB presence is tracked separately.
- Byte 1, bit 7: charging flag.
- Byte 1, bits 0..6: battery percentage.
- Byte 2: **`UNKNOWN`**.
- Byte 2 host behavior: copied into status caches.
- Byte 2 firmware meaning and original name: unavailable.
- Observed fully charged value: `E4` = charging + 100%.

Default timeouts:

- Sleep: 300 seconds, wire bytes `2C 01`.
- Power down: 600 seconds, wire bytes `58 02`.
- Both fields accept the full uint16 seconds range at protocol level.

## Onboard slots, layers, and host profiles

- The keyboard has exactly two onboard slots: `0` and `1`.
- Command `02`, selector `2` selects which onboard slot subsequent bank, macro, and lighting operations address.
- Command `04/05` selectors `0/1` mean Normal/Fn layers; they are not profile numbers.
- The vendor desktop application's extra `ProfileN.json` files are host-only presets.
- W910 WebDriver replaces host-only profiles with portable JSON backups and local named snapshots.

Vendor apply order observed dynamically:

1. Read current slot and generation tokens.
2. Select the target onboard slot.
3. Write a generation token.
4. Write Fn scroll records individually.
5. Write Normal scroll records individually.
6. Write the 160-record Normal main bank in 32-byte chunks.
7. Write the 160-record Fn main bank in 32-byte chunks.
8. Write lighting, timeout, and a refreshed generation token.

W910 WebDriver behavior:

1. Select and read the active onboard slot when the browser connects.
2. Serialize all writes so feature-report transactions never overlap.
3. Write only the changed four-byte action, macro stream, 25-byte lighting record/header, or two-byte timeout.
4. Read back and verify that same addressed record immediately.
5. For bulk restore or recovery, write the complete profile and perform complete readback comparison.
6. Do not touch generation tokens because the vendor application is not used concurrently.

## Generation tokens

- Storage: four 16-bit values returned by `82/1`; W910 uses the first two for its two onboard slots.
- Slot write address: `slot * 2`.
- Byte order: big-endian, unlike most other multibyte fields.
- Vendor local storage: `DeviceFeature.ini`, section `[RANDOM]`, key `ProfileN` as decimal.
- Vendor generator: pseudorandom integer in `1..65535`.
- Meaning: opaque cache-generation marker only.
- Not a checksum, hash, password, signature, firmware version, or data-integrity field.
- The device accepts arbitrary values; clients compare them without comparing profile contents.
- On mismatch, the vendor application can push its stale local profile to the device.
- Safe rule: do not mix the vendor application with an independent configurator unless its local JSON and INI token are synchronized together.
- W910 WebDriver intentionally ignores the field.

## Action banks and physical controls

Main bank per layer:

- Command: `04/84`.
- Capacity: 160 records × 4 bytes = 640 bytes.
- Chunking used by the vendor: eight records / 32 bytes per frame.
- Only 18 sparse records are connected on the W910 main bank.
- Generic filler: `02 00 00 00`.

Scroll bank per layer:

- Command: `05/85`.
- Capacity: four records × 4 bytes = 16 bytes.
- Connected records: indices 0 and 1.
- Unconnected records: indices 2 and 3.

Physical front layout:

- Key row 1: `Esc`, `B`, `C`, `D`, `E`.
- Key row 2: wide `Tab`, `X`, `V`, and the upper arm of the L-shaped `Enter` key.
- Key row 3: wide `Left Shift`, `K`, `R`, and the lower arm of the same `Enter` key.
- Right rail, top: one round five-way mode switch (`up`, `down`, `left`, `right`, `press`).
- Right rail, bottom/right: one vertical scroll wheel (`up`, `down`), offset to the right of the mode switch.
- Underside: one RGB light switch; holding it for three seconds in BT mode starts pairing.
- Total physical programmable inputs: 12 keyboard keys + five mode-switch inputs + one RGB light switch + two scroll inputs = 20.
- Main-bank index 2 is the underside RGB light switch.

Physical main controls:

| Index | Address | Control | Factory Normal action |
| ---: | ---: | --- | --- |
| 0 | `0000` | Esc | `02 29 00 00` |
| 1 | `0004` | X | `02 1B 00 00` |
| 2 | `0008` | RGB light switch (underside) | `07 01 00 00` |
| 8 | `0020` | B | `02 05 00 00` |
| 9 | `0024` | V | `02 19 00 00` |
| 10 | `0028` | Mode switch press | `09 03 00 00` |
| 16 | `0040` | C | `02 06 00 00` |
| 17 | `0044` | Enter | `02 28 00 00` |
| 18 | `0048` | Mode switch up | `02 52 00 00` |
| 24 | `0060` | D | `02 07 00 00` |
| 25 | `0064` | Left Shift | `02 E1 00 00` |
| 26 | `0068` | Mode switch down | `02 51 00 00` |
| 32 | `0080` | E | `02 08 00 00` |
| 33 | `0084` | K | `02 0E 00 00` |
| 34 | `0088` | Mode switch left | `02 50 00 00` |
| 40 | `00A0` | Tab | `02 2B 00 00` |
| 41 | `00A4` | R | `02 15 00 00` |
| 42 | `00A8` | Mode switch right | `02 4F 00 00` |

Factory scroll records:

| Layer | Index 0 / up | Index 1 / down | Indices 2 and 3 |
| --- | --- | --- | --- |
| Normal | `04 E9 00 00` volume up | `04 EA 00 00` volume down | `02 00 00 00` |
| Fn | `04 EA 00 00` volume down | `04 E9 00 00` volume up | `02 00 00 00` |

## Four-byte action format

| Type | Format | Meaning |
| ---: | --- | --- |
| `00` | `00 00 00 00` | No function |
| `02` | `02 usage 00 00` | USB HID keyboard usage |
| `03` | `03 sub 00 00` | System power/sleep/wake |
| `04` | `04 usageLE 00` | Consumer/media usage, 16-bit little-endian |
| `05` | `05 01/81 00 00` | Vertical wheel direction |
| `07` | `07 sub arg 00` | Lighting control |
| `09` | `09 sub arg 00` | Onboard profile control |
| `0A` | `0A mode slot 00` | Macro playback |
| `0B` | `0B 01/81 00 00` | Horizontal wheel direction |
| `0C` | `0C 01 00 00` | Fn layer |
| `0D` | `0D target state 00` | Key lock control |
| `0E` | `0E mode 00 00` | Windows/macOS mode |

Known commands exposed by the vendor UI or shared DevDock encoder:

| Category | Functions and action records |
| --- | --- |
| System | Power `03 01 00 00`; sleep `03 02 00 00`; wake `03 04 00 00` |
| Media | Mute `04 E2 00 00`; volume down/up `04 EA/E9 00 00`; previous/stop/next `04 B6/B7/B5 00 00`; play/pause `04 CD 00 00` |
| Applications | Media player `04 83 01 00`; mail `04 8A 01 00`; calculator `04 92 01 00`; my computer `04 94 01 00` |
| Browser | Search `04 21 02 00`; home `04 23 02 00`; back `04 24 02 00`; forward `04 25 02 00`; stop `04 26 02 00`; refresh `04 27 02 00`; bookmarks `04 2A 02 00` |
| Lighting | Mode loop `07 01 00 00`; speed loop/up/down `07 02 00/01/02 00`; brightness loop/up/down `07 03 00/01/02 00`; on/off `07 04 00 00`; color loop `07 06 00 00` |
| Profiles | Next `09 01 00 00`; previous `09 02 00 00`; loop `09 03 00 00`; direct slot 1/2 `09 04 00/01 00` |
| Locks | Windows key target `0D 01`; Alt+F4 target `0D 02`; all-key target `0D 03`; state `01` lock, `02` unlock, `03` toggle |
| OS mode | Windows `0E 01 00 00`; macOS `0E 02 00 00`; toggle `0E 03 00 00` |
| Mouse | Vertical +/− `05 01/81 00 00`; horizontal +/− `0B 01/81 00 00` |
| Display | Brightness down/up `04 6F/70 00 00` |

Macro action playback modes:

- `0`: replay the stream's fixed repeat count.
- `1`: replay while the physical control remains held.
- `2`: replay until the physical control is pressed again.

## Macro stream

Storage:

- Command: `08/88`.
- Selector: one-byte macro slot (`0..255` on the wire); actual device slot capacity is not established.
- The browser allocates the lowest slot not referenced by another action across both layers and banks. Physical key order does not determine the slot.
- Address: byte offset in the stream.
- Chunk size: up to 32 bytes.
- Maximum total stream: 512 bytes.

Header:

```text
offset 0..1  repeat count, uint16 little-endian
offset 2..3  event payload length, uint16 little-endian
offset 4..   encoded events
```

Captured Escape press with 20 ms delay:

```text
01 00 02 00 29 14
```

Keyboard and mouse-button events:

- Keyboard tag: HID usage `04..EC`.
- Mouse buttons use otherwise-reserved tags:
  - Left: `E8`
  - Right: `EA`
  - Middle: `E9`
  - Back: `EB`
  - Forward: `EC`
- Short delay range: `0..127` ms.

```text
[tag, delay]                         press
[tag, 80|delay]                      release
[tag, 7F, FF, delayMinus127_u24LE]  long press
[tag, FF, FF, delayMinus127_u24LE]  long release
```

Mouse wheel:

- Event tag: `FD`.
- `extVal`: one-byte direction/value; common values are `01` and `FF`.

```text
[FD, extVal]                         zero delay
[FD, extVal, FF, delay_u24LE]       delayed
```

Mouse movement:

- Event tag: `FE`.
- X and Y: signed 16-bit little-endian.

```text
[FE, delay8, x_s16LE, y_s16LE]
[FE, FF, x_s16LE, y_s16LE, FF, delayMinus255_u24LE]
```

Vendor JSON equivalents:

- `macVal`: key or pseudo mouse code.
- `macSta`: down/up/movement direction state.
- `macDly`: event delay in milliseconds.
- `extVal`: wheel or X/Y value.
- `num`: number of events.
- `macRpt`: fixed repeat count.
- `rptType`: playback mode `0/1/2`.
- Vendor pseudo codes: mouse buttons `F1..F5`, movement `F6`, wheel `F8`.

## RGB lighting

Mode header:

- Command: `09/89`.
- Selector: `0`.
- Address: `0`.
- Length: 25 bytes.

```text
byte 0      selected mode code 81..89
byte 1..2   supported-mode bitmap, uint16 little-endian; W910 = 01FF
byte 3..24  zero
```

Modes:

| Code | Mode | User controls |
| ---: | --- | --- |
| `81` | Constant | Brightness, single color |
| `82` | Flowing Water | Brightness, speed, direction, seven-color enable/palette |
| `83` | Horse Race | Brightness, speed, direction |
| `84` | Single-color Breathing | Brightness, speed, single color |
| `85` | Cycle Breathing | Brightness, speed, seven-color enable/palette |
| `86` | Tetris Blocks | Brightness, speed, seven-color enable/palette |
| `87` | Neon | Brightness, speed |
| `88` | Ambilight | Brightness, speed, direction |
| `89` | Off | No detail record |

- Mode names and controls: confirmed from vendor UI and captured records.
- Visual algorithms: not defined by the host records.
- Exact LED order, timing, interpolation, phase, and brightness curves: **`UNKNOWN`**.
- Host transfer: parameters only; no LED frames.
- Firmware dump: unavailable.
- Extraction evidence: [`FIRMWARE.md`](FIRMWARE.md).
- Modes `81` and `84`, byte 3: one-hot color selection.
- Captured red selection: `0x10`.
- Selected color storage: chosen slot's `[G,R,B]` triplet.
- Multi-color modes, byte 3: independent color-enable mask.

Detail record:

- Address: `(modeCode & 0x3F) * 25`.
- Length: 25 bytes.

| Offset | Meaning |
| ---: | --- |
| 0 | Speed, UI value `1..7` |
| 1 | Direction, `0` left/backward, `1` right/forward |
| 2 | Encoded brightness: `6 - UI brightness`; UI range `1..6` |
| 3 | One-hot color selection for `81`/`84`; seven-color enable mask for multi-color modes |
| 4..24 | Seven colors, three bytes each in unusual `[G, R, B]` order |

Verified example:

```text
04 01 00 7F FF FF 00 00 00 FF A5 FF 00 FF 00 00 00 FF 00 FF 00 FF 00 80 80
```

## Browser transport

- WebHID `data` argument: excludes the report-ID byte.

```js
const [device] = await navigator.hid.requestDevice({
  filters: [{ vendorId: 0xB6A4, productId: 0x4100, usagePage: 0xFF01, usage: 1 }],
});

await device.open();

// fullFrame is the 41-byte frame documented above.
await device.sendFeatureReport(0x06, fullFrame.slice(1));

// For reads, send the 0x80-bit request first, wait about 20 ms, then:
const response = await device.receiveFeatureReport(0x06);
```

- WebHID implementation: [`web/protocol.js`](web/protocol.js).
- BLE transport: implemented with FFF1 notification matching by command and sequence.

## Confirmed scope and remaining unknowns

Confirmed for complete reproduction of vendor-visible W910 configuration data and commands:

- Both onboard slots.
- Both Normal/Fn layers.
- All 18 main and two scroll inputs.
- All vendor-visible keyboard, consumer, system, profile, lock, OS, lighting, and macro actions.
- Macro key, five-button mouse, wheel, movement, delay, repeat, hold, and toggle encodings.
- All nine lighting modes, eight detail records, direction, brightness, speed, color enable mask, and `[G,R,B]` palette encoding.
- Sleep and power-down timeouts.
- Battery and charging status.
- Shared USB/BLE upper frame and the vendor BLE FFF0/FFF1 GATT transaction model.

- Completeness boundary: vendor-visible host configuration data and commands only.
- Excluded boundary: MCU internal lighting implementation.

Not required for W910 configuration and intentionally left unclaimed:

- Original stripped C++ variable names for status bytes 0 and 2.
- MCU physical NVM addresses and wear-leveling implementation.
- Product-specific meaning of dormant generic mouse DPI/polling/LOD commands.
- MCU firmware image and exact lighting algorithms.
- Firmware payload or updater in official package: absent.
- DFU/debug interface on connected unit: absent.
- Extraction evidence and hardware steps: [`FIRMWARE.md`](FIRMWARE.md).

## Reverse-engineering provenance

- Vendor application: SXS-W910 V1.0.4.
- Static analysis: 8,323 decompiled functions from the native executable plus the .NET BLE library.
- Product mapping: vendor JSON/XML/INI resources and the official W910 manual.
- Dynamic validation: proxied `HidD_SetFeature`/`HidD_GetFeature` calls on Windows 11 ARM64.
- Independent validation: direct USB readback without the vendor application.
- macOS raw-USB validation: complete Slot 1 read, unchanged full-profile write, and complete readback comparison on physical `B6A4:4100` hardware.
- Browser end-to-end validation: direct WebHID open plus physical report-ID-6 status, slot, and unchanged single-record write/readback in Chrome.
- 2.4 GHz receiver validation: physical report-ID-6 status, complete settings read, and unchanged sleep-timeout write/readback on `B6A4:4101`.
- BLE transaction reconstruction: decompiled `BLELib.BLE_Control` write, read, notify, and characteristic-property branches.
- Native BLE validation: physical FFF0/FFF1 discovery, status notification, and unchanged sleep-timeout write/readback through CoreBluetooth.
- Golden tests: captured key action, macro, lighting, profile, and byte-order values.

- Scope: observed interoperability behavior.
- Product and company names: property of their respective owners.
- License: [GNU General Public License v3.0](LICENSE).
