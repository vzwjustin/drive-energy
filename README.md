# Drive Energy

A live energy screen that reads the Model 3 vehicle CAN bus through an **OBDLink MX+** over Bluetooth and runs in **Chrome on Android**. There's no app to install and no server: the page talks to the adapter directly with Web Serial (Bluetooth RFCOMM).

**Listen-only.** The adapter is put in silent monitor mode (`ATCSM1`) behind pass filters. Nothing is transmitted on the car's bus.

## What you need

| Item | Requirement |
|---|---|
| Adapter | OBDLink MX+ (STN chip) on your Model 3 diagnostic harness, the same setup Scan My Tesla uses |
| Phone/tablet | Android with **Chrome 138 or newer** (Web Serial over Bluetooth shipped in 138) |
| Hosting | Any **https://** address. Web Serial refuses plain http. GitHub Pages works and is free. |

## 1. Host it (one time, about 5 minutes)

**GitHub Pages (recommended):**

1. On github.com, create a public repo named `drive-energy`.
2. Use **Add file → Upload files** and upload every file in this folder (keep `tests/` if you want it).
3. Go to **Settings → Pages**, set Source to **Deploy from a branch**, choose `main` and `/ (root)`, then **Save**.
4. After about a minute it's live at `https://<your-username>.github.io/drive-energy/`.

To try it locally on a desktop first, run `npx serve .` in this folder. Desktop Chrome treats `localhost` as secure, so Web Serial and the Demo both work.

## 2. First connect

1. In **Android Settings → Bluetooth**, pair the MX+ (PIN `1234` if it asks, per the OBDLink guide).
2. **Fully close Scan My Tesla and your own CAN app.** The MX+ allows only one Bluetooth serial connection at a time.
3. Wake the car (open a door or sit in it).
4. Open the page in Chrome and tap **Connect car**. Pick the OBDLink in the chooser.
5. The chip turns **Live** and the footer shows frames per second. Expect roughly **300–900 frames/s**.
6. Optional: in Chrome's menu, choose **Add to Home screen**. It then opens full-screen and works with no cell signal once it has loaded once.

On later visits, Chrome remembers the adapter, so **Connect car** skips the chooser.

## Away from the car: Tessie mode

Tap **Tessie** to run the same screen from Tessie's cloud instead of the adapter. Your car streams Fleet Telemetry to Tessie, so pack volts/amps, power and energy remaining refresh about every **10 s** while the car is awake.

- Paste your Tessie API token under **Settings → Tessie API token**. It's stored in that phone's browser only, so never put it in the repo; GitHub Pages repos are public.
- Tessie mode never wakes the car (`use_cache=true`). When the car sleeps, the chip shows how old the last reading is.
- Trip energy in Tessie mode comes from the drop in energy remaining (0.01 kWh steps). Regen and brick voltages aren't available there; bricks need the adapter.
- Tessie mode keeps its own trip, separate from the adapter's.

## What's on screen and where it comes from

| Value | CAN ID | Notes |
|---|---|---|
| Power (kW), volts, amps | `0x132` | V × I; positive means drawing from the pack, negative means regen or charging |
| Speed | `0x257` | Drive-inverter vehicle speed |
| Energy used | `0x3D2` | Lifetime kWh out and in, 1 Wh resolution. Trip energy = Δout − Δin, so regen is included exactly |
| Distance | `0x3B6` | Odometer, 0.001 km |
| Remaining / full pack / buffer | `0x352` | Handles both the pre-2021 layout and the 2021+ multiplexed layout (auto-detected) |
| SOC | `0x292` | Displayed (UI) SOC |
| Rated range, rated Wh/mi | `0x33A` | The dashed "rated" line on the chart |
| Pack temp min/max | `0x312` | |
| Regen/discharge limits | `0x252` | Scales the power bar |
| 108 brick voltages | `0x401` | Multiplexed, 3 bricks per frame |

How each number is worked out:

- **Right now (Wh/mi):** smoothed power ÷ speed. It shows above 3 mph only.
- **Avg · last N mi:** energy over distance from the lifetime counters, across the last 5, 15 or 30 miles of the trip.
- **Projected range:** (remaining − buffer) ÷ the average above. If there's no driving data yet, it falls back to rated range.
- **Trip** splits energy into driving, parked (odometer not moving), regen recovered and charging added. It saves to the phone and survives reconnects until you tap **Reset trip**.
- **Bricks:** lowest, highest, spread, a watched brick (default **38**) and its gap to the lowest of the other 107. The gap turns amber below −5 mV and red below −20 mV.

## Record CSV

Tap **Record CSV** to log one row per second: speed, power, V/A, odometer, kWh counters, SOC, energy remaining, full pack, min/max brick, watched brick, and pack temps. Tap again to stop, then tap **Download CSV**. Logging keeps the last 10 hours of rows.

## Verify on your car (first drive checklist)

- [ ] **Brick numbering:** compare the watched brick with Scan My Tesla once. If it's off by one, switch **Settings → Brick numbering** to 0–107.
- [ ] **Full pack kWh** should land near what SMT shows for Nominal Full Pack.
- [ ] **Trip distance** should match the car's trip meter within about 0.1 mi over 10 mi.
- [ ] **Power** while parked with climate off should read roughly **0.2–0.5 kW**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "This browser can't open Bluetooth serial ports" | Update Chrome to 138+, and open the https:// address (not a downloaded file) |
| Chooser shows no adapter | Pair the MX+ in Android Bluetooth settings first, and close other apps using it |
| "No reply to ATZ" | Unplug and replug the MX+, toggle Bluetooth, and tap Connect car again |
| Chip says **No CAN traffic** | The car is asleep, or the harness isn't on the vehicle bus. Open a door to wake it |
| Values freeze, then recover | The adapter buffer overflowed. The app restarts monitoring automatically |
| Adapter rejected ("needs an OBDLink/STN adapter") | Cheap ELM327 clones can't filter several IDs. Use the MX+ |

## Files

- `index.html`: layout and styles
- `app.js`: connection, trip math, rendering, CSV
- `elm.js`: STN/ELM command link over Web Serial
- `decode.js`: CAN signal decoders (usable in Node)
- `sim.js`: demo frame generator (the **Demo** button)
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline install
- `tests/decode.test.js`: run with `node tests/decode.test.js`

Signal layouts come from the community DBC at github.com/joshwardell/model3dbc (MIT) and the 2021+ `0x352` mux layout documented in the Battery-Emulator project. This is unofficial and not affiliated with Tesla.
