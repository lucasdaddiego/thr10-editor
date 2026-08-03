# Yamaha THR10 Family — MIDI SysEx Protocol Specification

Reverse-engineered reference for reimplementing a THR10/THR10C/THR10X/THR5/THR5A
editor over USB-MIDI (Web MIDI).

Sources (all claims traceable to these files):

- `THRAndroidEditor/src/de/sgrad/yamahathreditor/` — `SysExCommands.java`,
  `SysExParser.java`, `Patch.java`, `MainActivity.java`, `Simulator.java`,
  `PresetFileManager.java`, `Sysex.java`, the `*Data.java` model classes and the
  `Compressor/Modulation/Delay/Reverb/Gate/Amps/Cabinets.java` UI classes, plus
  the `assets/THR/*.YDP` / `*.YDL` preset files.
- `thr10/` firmware-analysis repo — `README.md`, `tools/midtobin.lua` (firmware
  dump framing, checksum cross-check).

Anything the code does not show is listed in **§10 Open questions** — nothing
below is invented.

---

## 1. Message framing overview

Every message is a Yamaha SysEx with this prefix:

| Byte | Value | Meaning |
|------|-------|---------|
| 0 | `F0` | SysEx start |
| 1 | `43` | Yamaha manufacturer ID |
| 2 | `7D` | THR "model"/family ID (used by all THR10-era messages) |
| 3 | *cmd* | Command/direction class (see below) |
| … | … | Command-specific payload |
| last | `F7` | SysEx end |

Observed values of byte 3 (`cmd` class):

| Byte 3 | Direction | Meaning | Source |
|--------|-----------|---------|--------|
| `00` | both | Bulk patch dump (276-byte "DTA1AllP" frame) | `Patch.java`, `Simulator.java` |
| `10` | editor → amp *and* amp → editor | Real-time parameter change (11-byte frame). The amp sends the same 11-byte layout when knobs are turned; `SysExParser.read()` does not even check byte 3 on receive. | `SysExCommands.java`, `SysExParser.java` |
| `20` | editor → amp | Request/attach ("give me current settings") | `MainActivity.java` |
| `30` | editor → amp | System settings (LED, Wide stereo) — 9-byte frame | `SysExCommands.java` |
| `30` | update mode | `DTA1ERASE` (firmware flash erase) | `thr10/tools/midtobin.lua` |
| `40` | update mode | `DTA1MAIN` firmware data blocks | `thr10/tools/midtobin.lua` |
| `50` | editor → amp (update mode) | `DTA1ROMR` firmware ROM read request | `thr10/README.md` |
| `60` | amp → editor | Model identification announce | `MainActivity.java` |
| `70` | amp → editor (update mode) | `DTA1CSUM` firmware checksum | `thr10/README.md`, `midtobin.lua` |

There is **no MIDI-standard Identity Request (`F0 7E … 06 01 F7`)** anywhere in
this codebase; identification is done with the proprietary `60`/`20` exchange
below.

---

## 2. Transport & handshake

Transport is plain USB-MIDI (the Android app uses `kshoji` UsbMidiDriver,
cable 0). No checksum on the short frames; only the bulk dump is checksummed.

### 2.1 Amp identification (amp → editor)

The amp emits a 9-byte announce (the editor passively waits for it after the
USB MIDI device appears — the app never sends a request first):

```
F0 43 7D 60 44 54 41 mm F7          ; "DTA" + model byte
```

`44 54 41` = ASCII `DTA`. Model byte `mm` (`SysExCommands.THRModel`):

| `mm` | Model |
|------|-------|
| `30` | THR5 |
| `31` | THR10 |
| `32` | THR10X |
| `33` | THR10C |
| `34` | THR5A |

(Source: `MainActivity.onMidiSystemExclusive()` — checks length 9 and bytes
1–6 = `43 7D 60 44 54 41`, then maps byte 7.)

### 2.2 Editor attach / dump request (editor → amp)

Immediately after a valid model is detected, the editor sends (13 bytes):

```
F0 43 7D 20 44 54 41 31 41 6C 6C 50 F7      ; ASCII "DTA1AllP"
```

(`MainActivity.sysExMsgEditorStart`.) The amp answers with the full 276-byte
settings dump (§4). The same message is byte-identical for all models (a
commented-out experiment setting byte 7 to `33` for THR10C was abandoned).

### 2.3 Keepalive / heartbeat

None exists in this code. After the attach message the link is event-driven in
both directions. (Whether the amp re-announces `…60 44 54 41 mm F7`
periodically is not shown — see Open questions.)

---

## 3. Real-time parameter change (11-byte frame, both directions)

Template (`SysExCommands.sysExMsgFrame`, also shown in the debug UI in
`Sysex.java`):

```
F0 43 7D 10 41 30 01 PP HH LL F7
                     │  │  └─ low byte  (7-bit)
                     │  └─ high byte (7-bit, only for 14-bit params, else 00)
                     └─ parameter ID
```

Bytes 4–6 are always `41 30 01` in this direction. The amp sends the same
layout for front-panel knob turns; the parser (`SysExParser.read()`) accepts
any 11-byte `F0 … F7` and dispatches purely on `in[7]` (param ID), `in[8]`,
`in[9]`.

### 3.1 14-bit value encoding

Parameters wider than 7 bits use a 14-bit big-endian 7-bit split
(`SysExCommands.encodeIntegerTo7Bit` / `decode7BitByteToInt`):

```
HH = (value >> 7) & 0x7F
LL =  value       & 0x7F
```

Worked examples from source comments: `0x270F` (999.9 ms) → `4E 0F`;
`0x2EE0` (12000 Hz) → `5D 60`; `0x0F46` (391.0 ms) → `1E 46`.
7-bit parameters put their value in `LL` with `HH = 00`.

### 3.2 Parameter ID map (`PP`)

High nibble of `PP` selects the block (`SysExParser.DeviceIdentifier`):
`0x` amp/controls, `1x` compressor, `2x` modulation, `3x` delay, `4x` reverb,
`5x` gate. `x0` = type select, `xF` = block on/off, others are parameters.

**On/off convention everywhere: `00` = ON, `7F` = OFF.**

#### Amp / main controls (`0x00`–`0x06`)

| `PP` | Parameter | Value (`LL`) | Source |
|------|-----------|--------------|--------|
| `00` | Amp model select | `00`–`07`, see §7 | `getAmpTypeSysEx` |
| `01` | Gain | `00`–`64` (0–100) | `Controls.GAIN`, knob max 100 |
| `02` | Master | `00`–`64` | `Controls.MASTER` |
| `03` | Bass | `00`–`64` | `Controls.BASS` |
| `04` | Middle | `00`–`64` | `Controls.MIDDLE` |
| `05` | Treble | `00`–`64` | `Controls.TREBLE` |
| `06` | Cabinet select | `00`–`06`, see §7 | `getCabinetTypeSysEx` |

`Controls.PRESENCE` = `0x06` is also declared in `SysExCommands.java` but never
used as a control (it collides with cabinet select) — see Open questions.

#### Compressor (`0x10`–`0x1F`)

| `PP` | Parameter | Encoding / range |
|------|-----------|------------------|
| `10` | Type: `LL=00` Stomp, `LL=01` Rack | |
| `11` | Stomp **Sustain** (7-bit, 0–100) *or* Rack **Threshold** (14-bit, 0–`0x258`=600; display `(v-600)/10` dB → −60.0…0.0 dB) — meaning depends on currently selected type | `Compressor.java` |
| `12` | Stomp **Output** (0–100) | |
| `13` | Rack **Attack** (0–100) | |
| `14` | Rack **Release** (0–100) | |
| `15` | Rack **Ratio** enum 0–5 → `1:1, 1:4, 1:8, 1:12, 1:20, 1:inf` | |
| `16` | Rack **Knee** enum 0–2 → `soft, medium, hard` | |
| `17` | Rack **Output** (14-bit, 0–`0x258`=600; display `(v-200)/10` dB → −20.0…+40.0 dB) | |
| `1F` | Compressor on/off (`00` on / `7F` off) | `getDeviceOnOffSysEx` |

#### Modulation (`0x20`–`0x2F`) — parameter meaning depends on selected type

| `PP` | Chorus | Flanger | Tremolo | Phaser |
|------|--------|---------|---------|--------|
| `20` | type `00` | type `01` | type `02` | type `03` |
| `21` | Speed | Speed | Freq | Speed |
| `22` | Depth | Manual | Depth | Manual |
| `23` | Mix | Depth | — | Depth |
| `24` | — | Feedback | — | Feedback |
| `25` | — | Spread | — | — |
| `2F` | on/off | on/off | on/off | on/off |

All modulation parameters are 7-bit, range 0–`0x64` (0–100), unitless in the
UI (`Modulation.java`).

#### Delay (`0x30`–`0x3F`)

| `PP` | Parameter | Encoding | Range | Display |
|------|-----------|----------|-------|---------|
| `31` | Time | 14-bit | `0x0001`–`0x270F` (1–9999) | value/10 ms → 0.1–999.9 ms |
| `33` | Feedback | 7-bit | 0–`0x64` | 0–100 |
| `34` | High Cut | 14-bit | `0x03E8`–`0x3E81` (1000–16001 Hz) | 16001 = "Thru" |
| `36` | Low Cut | 14-bit | `0x0015`–`0x1F40` (21/22–8000 Hz) | 21 = "Thru" |
| `38` | Level | 7-bit | 0–`0x64` | 0–100 |
| `3F` | on/off | | `00`/`7F` | |

(Ranges from `Delay.java` constants `TIME_MAX = 0x270F`, `HIGHCUT_MAX = 0x3e81`,
`HIGHCUT_MIN = 0x3e8`, `LOWCUT_MAX = 0x1f40`, `LOWCUT_MIN = 0x15`.)

#### Reverb (`0x40`–`0x4F`)

Type select: `PP=40`, `LL`: `00` Hall, `01` Room, `02` Plate, `03` Spring
(`ReverbType`). Parameter meaning depends on type:

Hall/Room/Plate:

| `PP` | Parameter | Encoding | Range | Display |
|------|-----------|----------|-------|---------|
| `41` | Time | 14-bit | `0x03`–`0xC8` (3–200) | value/10 s → 0.3–20.0 s |
| `43` | Pre delay | 14-bit | `0x01`–`0x07D0` (1–2000) | value/10 ms → 0.1–200.0 ms |
| `45` | Low Cut | 14-bit | `0x0015`–`0x1F40` | 21 = Thru, else Hz |
| `47` | High Cut | 14-bit | `0x03E8`–`0x3E81` | 16001 = Thru, else Hz |
| `49` | High Ratio | 7-bit | `01`–`0A` (1–10) | integer |
| `4A` | Low Ratio | 7-bit | `01`–`0E` (1–14) | integer |
| `4B` | Level | 7-bit | 0–`0x64` | 0–100 |

Spring:

| `PP` | Parameter | Encoding | Range |
|------|-----------|----------|-------|
| `41` | Reverb amount | 7-bit | 0–`0x64` |
| `42` | Filter | 7-bit | 0–`0x64` |

| `PP` | | |
|------|---|---|
| `4F` | Reverb on/off | `00`/`7F` |

#### Gate (`0x50`–`0x5F`)

| `PP` | Parameter | Encoding | Range |
|------|-----------|----------|-------|
| `51` | Threshold | 7-bit | 0–`0x64` |
| `52` | Release | 7-bit | 0–`0x64` |
| `5F` | Gate on/off | `00`/`7F` |

Note: Gate and Compressor are flagged in `SysExParser.java` comments as *"not
switchable from unit"* — their on/off only ever originates from the editor.

---

## 4. Bulk patch dump (276 bytes, both directions)

Sent by the amp in response to the `DTA1AllP` attach request; sent by the
editor to load a whole patch into the amp. **One single SysEx message — there
is no multi-part framing for patch dumps** (multi-part framing exists only for
firmware dumps, §9). `SysExParser.read()` recognizes it purely by
`in.length == 276`.

### 4.1 Layout (`Patch.java`, verified against `Simulator.dump1`)

```
offset  size  content
------  ----  -------------------------------------------------------
0       4     F0 43 7D 00                          (MESSAGE_START)
4       2     02 0C                                length of data section,
                                                   14-bit: 2*128+12 = 268 = DATA_SIZE (0x10C)
6       12    44 54 41 31 41 6C 6C 50 00 00 7F 7F  PATCH_MAGIC = "DTA1AllP\0\0\x7F\x7F"
18      128   patch name, ASCII, NUL padded
146     130   parameter payload (see 4.3; last byte of it forced to 00)
274     1     checksum (see 4.2)
275     1     F7
```

Constants from `Patch.java`: `HEADER_SIZE = 6`, `DATA_SIZE = 0x10C` (268 =
12 magic + 128 name + 96 data + 32 tail), `TRAILER_SIZE = 2`,
`SYSEX_SIZE = 276`.

### 4.2 Checksum

Two's-complement 7-bit checksum over the **268 data bytes** (offsets 6..273,
i.e. magic + name + payload):

```
cs = 0; for (i = 0; i < 268; i++) cs += dump[6 + i];
dump[274] = (~cs + 1) & 0x7F;          // so that (sum + checksum) & 0x7F == 0
```

(`Patch.getPresetSysExDump()`; the identical "sum of data & 0x7F must be 0"
rule is used by the firmware's `DTA1MAIN` blocks in `thr10/tools/midtobin.lua`,
confirming the algorithm.) Byte `dump[273]` (last payload byte) is forced to
`00` before checksumming (*"Last byte of patch has to be zero. No idea why"* —
`Patch.java`).

Example: `Simulator.dump1` checksum byte `0x67` (verified correct by
reimplementation). Note: `Simulator.dumpPlex`'s stored checksum `0x30` is
**wrong** — the algorithm yields `0x2E` for its data bytes; the simulator's
hardcoded array was apparently hand-edited without recomputing. Only `dump1`
should be treated as a faithful capture.

### 4.3 Parameter payload (offsets relative to payload start = dump offset 146)

| Payload offset | Size | Content |
|-------|------|---------|
| 0 | 1 | Amp model (enum §7) |
| 1 | 1 | Gain (0–100) |
| 2 | 1 | Master |
| 3 | 1 | Bass |
| 4 | 1 | Middle |
| 5 | 1 | Treble |
| 6 | 1 | Cabinet (enum §7) |
| 7–15 | 9 | unknown (zeros in all observed dumps) |
| 16–31 | 16 | Compressor block |
| 32–47 | 16 | Modulation block |
| 48–63 | 16 | Delay block |
| 64–79 | 16 | Reverb block |
| 80–95 | 16 | Gate block |
| 96–127 | 32 | unknown tail ("Tail" in `Patch.java` size math; zeros observed) |
| 128 | 1 | forced `00`, then checksum+`F7` follow |

Each 16-byte effect block: byte 0 = type, byte 15 = on/off (`00` on / `7F`
off), 14-bit values stored as HH,LL pairs in place:

**Compressor block** (`CompressorData.java`):

| off | Stomp (`[0]=00`) | Rack (`[0]=01`) |
|-----|------------------|-----------------|
| 0 | `00` | `01` |
| 1 | Sustain | Threshold HH |
| 2 | Output | Threshold LL |
| 3 | — | Attack |
| 4 | — | Release |
| 5 | — | Ratio (0–5) |
| 6 | — | Knee (0–2) |
| 7 | — | Output HH |
| 8 | — | Output LL |
| 15 | on/off | on/off |

**Modulation block** (`ModulationData.java`): byte 0 = type
(`00` Chorus, `01` Flanger, `02` Tremolo, `03` Phaser), then:

| off | Chorus | Flanger | Tremolo | Phaser |
|-----|--------|---------|---------|--------|
| 1 | Speed | Speed | Freq | Speed |
| 2 | Depth | Manual | Depth | Manual |
| 3 | Mix | Depth | — | Depth |
| 4 | — | Feedback | — | Feedback |
| 5 | — | Spread | — | — |
| 15 | on/off | on/off | on/off | on/off |

**Delay block** (`DelayData.java`):

| off | Field |
|-----|-------|
| 1,2 | Time HH,LL |
| 3 | Feedback |
| 4,5 | HighCut HH,LL |
| 6,7 | LowCut HH,LL |
| 8 | Level |
| 15 | on/off |

**Reverb block** (`ReverbData.java`): byte 0 = type (`00` Hall, `01` Room,
`02` Plate, `03` Spring).

| off | Hall/Room/Plate | Spring |
|-----|------------------|--------|
| 1,2 | Time HH,LL | 1 = Reverb, 2 = Filter |
| 3,4 | Pre HH,LL | — |
| 5,6 | LowCut HH,LL | — |
| 7,8 | HighCut HH,LL | — |
| 9 | HighRatio | — |
| 10 | LowRatio | — |
| 11 | Level | — |
| 15 | on/off | on/off |

**Gate block** (`GateData.java`):

| off | Field |
|-----|-------|
| 1 | Threshold |
| 2 | Release |
| 15 | on/off |

### 4.4 Patch name

128 bytes at dump offset 18, ASCII. Reader (`Patch.bytesToString`) takes
printable chars (32–127) until the first non-printable/NUL, scanning at most
48 chars. Writers NUL-pad the remainder. Empty name is treated as
"nameless patch" (`SysExParser.java`).

### 4.5 Writing a patch to the amp

The editor sends the *same* 276-byte dump it would receive (rebuilt with
`Patch.getPresetSysExDump()`, checksum recomputed). This sets the amp's live
edit buffer. **No command for storing to the amp's 5 physical preset-button
slots exists in this code** (see Open questions).

---

## 5. System messages (9 bytes, editor → amp)

`SysExCommands.getLEDOnOffSysEx` / `getWideModeOnOffSysEx`:

```
F0 43 7D 30 41 30 FF VV F7
```

| `FF` (byte 6) | Function |
|------|----------|
| `01` | Amp LED illumination |
| `00` | "Wide" stereo mode |

| `VV` (byte 7) | Meaning |
|------|---------|
| `00` | On |
| `01` | Off |

(Note this on/off convention differs from the `00`/`7F` used by effect blocks.)

---

## 6. Messages received from the amp — summary & parser behavior

`MainActivity.onMidiSystemExclusive` → `SysExParser.read(byte[])`. There is no
streaming state machine for normal operation; the USB-MIDI driver delivers
complete SysEx messages and the parser dispatches on **total length**:

| Length | Meaning | Handling |
|--------|---------|----------|
| 9 | Model announce `F0 43 7D 60 44 54 41 mm F7` | handled in `MainActivity` before the parser; triggers the `DTA1AllP` request |
| 11 | Parameter change notification (knob turned on the amp, or echo) — same layout as §3 | dispatched on `in[7]`; stateful params (`0x11`, `0x21`–`0x23`, `0x41`) are interpreted using the *currently known* effect type |
| 13 | Unknown — parser has an explicit **empty** branch `else if (in.length == 13) {}` | ignored |
| 276 | Full settings dump (§4) | name from bytes 18–145, payload from 146 |

There are no ACKs for editor→amp messages anywhere in this code; the editor
fires and forgets.

Important implementation subtlety: for ambiguous parameter IDs (compressor
`0x11` = Stomp Sustain *or* Rack Threshold; modulation `0x21`–`0x23`; reverb
`0x41`/`0x42`), the receiver must track the last-selected type — the amp sends
the type-select message (`x0`) before/independently of the value messages.

---

## 7. Amp models, cabinets & device variants

### 7.1 Amp model enum (payload byte 0 / param `0x00`)

`SysExCommands.AmpType` — same byte values on every device, display names vary:

| Value | THR10 name | THR10C name |
|-------|-----------|-------------|
| `00` | Clean | Deluxe |
| `01` | Crunch | Class A |
| `02` | Lead | US Blues |
| `03` | BritHi | Brit Blues |
| `04` | Modern | Mini |
| `05` | Bass | Bass |
| `06` | Aco | Aco |
| `07` | Flat | Flat |

THR10X and THR5A name tables are **empty stubs** in `Amps.changeAmpButtonText`
(the code returns `""` for models other than THR10/THR10C) — names for those
devices are unknown here (Open questions).

### 7.2 Cabinet enum (payload byte 6 / param `0x06`)

`SysExCommands.CabinetType`:

| Value | THR10 name | THR10C name (as coded) |
|-------|-----------|-------------------------|
| `00` | US 4x12 | BritBlues 2x12 |
| `01` | US 2x12 | US2x12 † |
| `02` | Brit 4x12 | California 1x12 |
| `03` | Brit 2x12 | American 1x12 |
| `04` | 1x12 | Boutique 2x12 |
| `05` | 4x10 | Yamaha 2x12 |
| `06` | None | None |

† The THR10C column is internally inconsistent between
`SysExCommands.CabinetType.toString()` and `Cabinets.changeCabinetButtonText()`
(the latter labels both `btn1x12` and `btnUS2x12` "Boutique 2x12" and maps
`4x10`→"Yamaha 2x12", `US4x12`→"BritBlues 2x12") — treat THR10C cabinet names
as unverified.

The `thr10` firmware notes confirm each amp model has a default cabinet that is
re-applied whenever the amp model changes; a cabinet set via SysEx survives
only until the next model change (`thr10/README.md`, "Cabinet simulation
bypass").

### 7.3 Protocol differences between variants

As far as this code shows, **the wire protocol is identical for all five
models**; the only difference is the model byte in the `…60 44 54 41 mm F7`
announce (§2.1) and which preset library file the app loads (§8). THR5 and
THR10 even share one library file (`THR5_10.YDL`). No per-model parameter maps
exist in the code.

---

## 8. Patch file formats (official editor formats used by this app)

### 8.1 `.YDP` — single patch ("program"), 265 bytes

(`PresetFileManager.java` + hexdumps of `assets/THR/*.YDP`.)

```
offset  size  content
0       4     "DTAP"  (44 54 41 50)
4       5     header bytes — observed variants: 00/01, 00/02, 00, 00–03, 00
              (code writes 44 54 41 50 00 02 00 00 00; real files vary — see
              Open questions; offset 7 loosely correlates with target model)
9       256   patch record (identical to dump data minus magic):
  9       128   name (ASCII, NUL padded)
  137     1     amp model
  138     5     gain, master, bass, middle, treble
  143     1     cabinet
  144–152  9    unknown
  153     16    compressor block   (= name+16  → file offset 128+9+16)
  169     16    modulation block
  185     16    delay block
  201     16    reverb block
  217     16    gate block
  233     32    unknown tail
```

i.e. file = 9-byte header + the same 256-byte `Name(128)+Data(96)+Tail(32)`
record used in the SysEx dump. Loader check: extension `.YDP` **and** file
length exactly 265.

To send a `.YDP` to the amp: strip the 9-byte header, take the 256-byte record,
wrap it in the §4 dump frame (magic, length `02 0C`, checksum) and transmit
(`PresetFileManager.decodePresetData`).

### 8.2 `.YDL` — patch library, 26108 bytes (`0x65FC`)

(`Patch.java` comments + `loadLibraryContent()` + hexdumps.)

```
offset  size   content
0       7      "DTAB01d" (44 54 41 42 30 31 64)
7       6      variable header bytes; offset 0x0B observed = 00 (THR5/10),
               02 (THR10X), 03 (THR10C) — matches low nibble of model ID;
               THR5A file instead has 01 at offset 0x08 (see Open questions)
0x0D    …      patch records, each 261 (0x105) bytes:
                 256-byte record (Name 128 + Data 96 + Tail 32) + 5 pad bytes
```

Records are read sequentially from `0x0D` while at least 256 bytes remain
(`Patch.loadLibraryContent`). 26108 = 13 + 100×261 − 5, i.e. 100 slots with
the final record's 5 pad bytes truncated. The comment in `Patch.java` guesses
the `64` (`= 100`) in the header is the patch count. Loader check: extension
`.YDL` and length exactly `0x65FC`.

Writing a slot: seek to `0x0D + slot*261` and write the 261-byte record
(`Patch.java` long-press handler).

Library files per model (`Patch.getLibraryFile`): THR5 & THR10 →
`THR5_10.YDL`, THR10C → `THR10C.YDL`, THR10X → `THR10X.YDL`, THR5A →
`THR5A.YDL`.

---

## 9. Firmware update mode (from the `thr10` repo, for cross-reference only)

Not needed for an editor, but confirms conventions:

- Firmware dump request: `F0 43 7D 50 44 54 41 31 52 4F 4D 52 02 F7`
  ("DTA1ROMR", section `02`).
- Firmware data arrives as `DTA1MAIN` messages: `F0 43 7D 40 SZH SZL "DTA1MAIN"
  BLKH BLKL NUMH NUML data… F7`, 14-bit size/block counters, payload packed as
  7 data bytes + 1 high-bits byte per group, and **sum of data bytes ≡ 0 mod
  0x80** — the same 7-bit two's-complement checksum family as the patch dump.
- Dump ends with `DTA1CSUM`: `F0 43 7D 70 44 54 41 31 43 53 55 4D cs F7`.
- `DTA1ERASE`: `F0 43 7D 30 44 54 41 31 45 52 41 53 45 02 F7` class.

(`thr10/README.md`, `thr10/tools/midtobin.lua`.)

---

## 10. Open questions — verify against a real amp

> **2026-08-02, real THR10 over macOS/CoreMIDI:** the §2 handshake is
> verified end-to-end — `DTA1AllP` → 276-byte dump, checksum algorithm
> confirmed valid on a live capture (`tests/fixtures/thr10-real-dump.syx`),
> and the dump decodes to the values shown on the amp. Items below are
> annotated where that session answered them.

1. **13-byte received message**: `SysExParser` has an empty branch for
   `length == 13`. The editor-attach request itself is 13 bytes — possibly an
   echo/ACK of `DTA1AllP`, but the code never inspects it. Capture and identify.
   *Partially answered 2026-08-02: no 13-byte message was observed in response
   to `DTA1AllP` on macOS/CoreMIDI. Possibly Android-driver-specific.*
2. **Amp announce trigger**: does the amp send `F0 43 7D 60 44 54 41 mm F7`
   once on USB enumeration, on power-up, periodically (heartbeat), or in
   response to something? The app just waits for it.
   *Answered 2026-08-02: the amp re-emits the announce immediately **after
   every 276-byte dump it sends**. An editor that requests a dump on every
   announce therefore loops forever — announce-triggered requests must be
   suppressed right after receiving a dump. (Whether it also announces on
   power-up/enumeration alone is still unobserved but presumed.)*
3. **`0x41 0x30 0x01` header bytes** (bytes 4–6 of the 11-byte frame): meaning
   unknown (possibly ASCII "A0" + `01`). Whether other values are valid, and
   what the amp puts there in knob-turn notifications, is unverified — the
   parser ignores bytes 1–6 entirely on receive.
4. **Payload bytes 7–15 and 96–127** of the dump are never decoded (zeros in
   both sample dumps). THR10X-specific features (e.g. its extra amp models /
   "Presence"?) may live there.
   *Consistent 2026-08-02: all zero in the real THR10 capture as well.*
5. **`Controls.PRESENCE = 0x06`** is declared but collides with cabinet select
   and is never sent or parsed. Real meaning unknown (THR5 variants?).
6. **THR10X and THR5A amp/cab display names**: code stubs are empty. Byte
   values `00`–`07` presumably still apply, but names and count per device are
   unverified.
7. **THR10C cabinet name table** is self-contradictory in the code (§7.2).
8. **Storing to the amp's physical preset buttons 1–5**: no command in this
   code. The 276-byte dump only sets the edit buffer.
9. **`.YDP`/`.YDL` header bytes** (YDP offsets 4–8, YDL offsets 7–12): meaning
   inferred only partially (model-nibble correlation, `0x64` = 100 slots is a
   guess from a comment). The code's own YDP write header
   (`DTAP 00 02 00 00 00`) does not match most shipped files
   (`DTAP 00 00 00 01 00`, `DTAP 01 00 00 02 00`, …).
10. **"Last byte of patch has to be zero"** (dump offset 273): the original
    author didn't know why; unknown whether nonzero values are rejected.
11. **Value clamping**: mins like Delay `TIME_MIN=1`, Reverb `TIME_MIN=3`,
    `LOWCUT` 21 = Thru vs 22 = min are UI-enforced; the amp's actual accepted
    ranges/behavior at the edges are unverified.
12. **On/off asymmetry**: effect blocks use `00`=on/`7F`=off, but LED/Wide use
    `00`=on/`01`=off. Whether the amp accepts `01` as "off" for effects (or
    `7F` for LED) is untested.
13. **Multiple parameter changes**: no rate limiting or coalescing exists in
    the app; whether the amp needs pacing under Web MIDI bursts is unknown.
