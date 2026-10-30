# Drive Energy

A live energy screen that reads the Model 3 vehicle CAN bus through an **OBDLink MX+** over Bluetooth and runs in **Chrome on Android**. There's no app to install and no server: the page talks to the adapter directly with Web Serial (Bluetooth RFCOMM).

**Listen-only.** The adapter is put in silent monitor mode (`ATCSM1`) behind pass filters. Nothing is transmitted on the car's bus.

## What you need

| Item | Requirement |
|---|---|
| Adapter | **OBDLink MX+** (STN chip) or **vLinker FS / MC+ / other ELM327-class** Bluetooth Classic adapter on your Model 3 diagnostic harness |
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

## Efficiency cluster (top of the screen)

- **Efficiency gauge:** live Wh/mi, smoothed over a few seconds.
  - The arc is green up to your **target**, amber to 1.35× the target, and red beyond.
  - The target is your own best steady-cruise Wh/mi at this speed and outside temperature, or the rated figure until enough data exists. The white tick marks it.
  - The amber dot is your trip average. The badge underneath reads **Efficient**, **A bit heavy** or **Wasting range**.
- **Efficiency score (0–100, this trip):**
  - 70% is consumption vs rated: 100 at 15% or more under rated Wh/mi, 0 at 50% or more over.
  - 30% is the share of pedal time spent in the 15–40% range.
- **Tiles:** range at this pace, average over the last 5/15/30 mi, and power.
- **Power flow bar:** regen to the left of zero, power used to the right, with green "efficient" zones on both sides. The label states it in words, for example "12 kW · efficient" or "35 kW regen · strong, lift earlier".

## Range tools (v16–v20)

- **Mile by mile:** each of the last 10 whole miles plus the current one, as bars colored against your target, with a dashed target line.
- **Slowdown capture:** for every slowdown from 15+ mph that loses at least 10 mph with your foot mostly off the pedal, the share of the car's momentum (½·m·v², 1850 kg) that came back as regen.
  - Drag and rolling resistance take some of it, so **60%+ is excellent**.
  - It's reported on the Coach card, in the second coaching line right after each slowdown, and in drive summaries.
- **Climate / parked draw chip:** compressor kW, or standby draw while stopped, converted to **miles of range per hour** at your pace.
- **Speed curve:** your learned Wh/mi by speed, with the sweet spot and your current speed marked, plus how far your current charge goes at each speed.
- **Charge plan:** what % to charge to for the miles you need plus an arrival reserve, at your last-7-drives Wh/mi.
- **Drive summaries and history:** a score, comparison with rated, slowdown capture, energy breakdown and the one habit to fix, with trends across drives.
- Slower-changing panels redraw once a second to keep the phone cool in a mount.

## Eyes-free alerts (Settings, off by default)

Choose Vibrate, Sound, or both. Each alert fires when a costly habit **starts**, at most once per 15 s per kind, never while **Cruise / Autopilot on** is set, and only above 5 mph.

| Signal | Meaning |
|---|---|
| One low tone / short buzz | Ease off: heavy pedal or a sharp lift-off |
| Two high tones / double buzz | Lift earlier: braking with little regen, or regen at its limit |
| Long low tone / long buzz | Pack warning: cold pack under high draw, hot pack, or low charge under high draw |

Tap **Test alert** once to allow sound (browsers require a tap before audio).

## Max-range guide

Everything below is driven by **your car's own steady-cruise data** (the coach's speed table at the current outside temperature), falling back to rated consumption until enough data exists.

- **Power meter target bands (green):**
  - Up: efficient draw = the power that holding this speed costs you, plus a gentle-acceleration allowance (~0.06 g).
  - Down: gentle regen = up to 60% of the BMS regen limit (35 kW max).
  - The bar turns teal inside the band, amber above it, and red past about 1.8× the band. Regen past the gentle band turns amber.
- **Right now (Wh/mi)** turns green within 10% of the target for this speed, amber up to 40% over, and red beyond.
- **Range vs rated:** projected range at your pace minus the car's rated range. Positive means you're beating the car's estimate.
- **Best speed:** your most efficient 5-mph band, plus how many miles slowing to it would add right now.
- **Range goal:** tap it and enter the miles you need. It shows the Wh/mi budget to get there, whether you're on budget, the arrival battery %, and if you're over, the speed to slow to (the fastest band in your data that fits the budget). A dotted budget line appears on the chart.
- **Drive view** (header button): hides everything except the meter, numbers, guide chips and coaching tip, all enlarged for a quick glance, and keeps the screen on.

## Range coach (needs the adapter)

Same rules, thresholds and wording as EcoLab's `RangeCoach` (github.com/vzwjustin/eco, `core/sim/RangeCoach.kt`), so both apps coach the same way. Listen-only.

- **Pedal bar:** green zone **15–40%**, with 1% hysteresis so the color doesn't flicker. Light (<15%) is amber, too much (>40%) is red, and while lifting off it shows the regen being recovered.
- **Uphill exemption:** a heavy pedal that's only holding speed uphill (car's `DI_gradeEst` above 2%, not accelerating) counts as in range.
- **Cue order:** warnings first, then good, then tips. The top cue is the headline (held at least 3 s), the next one shows underneath, and a "look ahead and coast" reminder is always last.
- **Cues:**
  - Pack cold, pack hot, low charge with high draw
  - Near full (>95%) so regen is limited, or regen limited below 15 kW
  - Braking with little regen
  - Regen at its limit, sharp lift-off
  - One-pedal slowing, coasting, feathering, smooth acceleration
  - Light pedal at a steady speed, holding speed uphill, heavy pedal
  - Uphill/downhill, cold or hot air, climate draw over 3 kW, cruise on, above ~70 mph
- **Drive Energy addition:** "5 mph slower saves X%", based on your own speed table.
- **Speed vs Wh/mi** is learned from steady cruising and split by outside temperature (<40, 40–59, 60–79, 80+ °F).
- **Cruise / Autopilot on** toggle: the cruise signal isn't on the vehicle bus, so tap it while cruise is holding speed. That turns off pedal coaching and adds the cruise tip.
- Not covered here: EcoLab's wind estimate, tire-pressure, and speed-limit cues. Those frames usually aren't on the OBD vehicle bus.
- **Not validated on a car**, same as EcoLab: the 15–40% zone is a starting estimate.

## Away from the car: Tessie mode

Tap **Tessie** to run the same screen from Tessie's cloud instead of the adapter. Your car streams Fleet Telemetry to Tessie, so pack volts/amps, power and energy remaining refresh about every **10 s** while the car is awake.

- Paste your Tessie API token under **Settings → Tessie API token**. It's stored in that phone's browser only, so never put it in the repo; GitHub Pages repos are public.
- Tessie mode never wakes the car (`use_cache=true`). When the car sleeps, the chip shows how old the last reading is.
- Trip energy in Tessie mode comes from the drop in energy remaining (0.01 kWh steps). Regen and brick voltages aren't available there; bricks need the adapter.
- Tessie mode keeps its own trip, separate from the adapter's.

## Auto-connect (v21)

After you pick the adapter once, Chrome remembers the permission. While the page is open (Drive view on a mounted phone works well) and nothing else is connected, the app tries that adapter:

- on page load,
- whenever Chrome reports the Bluetooth adapter in range,
- every 15 s,
- and again when you switch back to the tab.

The chip shows **Looking for the adapter…** until the car powers the OBD port.

- **Disconnect** pauses auto-connect until you tap **Connect car** again. You can turn it off under Settings.
- **Limit:** Chrome can't connect while the page is closed or in the background. Web pages can't run Bluetooth in the background, so open the app (or keep it as the home-screen app) when you get in.
- Close Scan My Tesla and other OBD apps first: the adapter allows one connection at a time.

## What's on screen and where it comes from

| Value | CAN ID | Notes |
|---|---|---|
| Power (kW), volts, amps | `0x132` | V × I; positive means drawing from the pack, negative means regen or charging |
| Speed | `0x257` | Drive-inverter vehicle speed |
| Accelerator %, brake, gear | `0x118` | Feeds the range coach |
| Road grade | `0x267` | `DI_gradeEst`, for the uphill exemption |
| Outside temp | `0x321` | Splits the speed table, plus cold/hot cues |
| Compressor power | `0x2A8` | Climate-draw cue |
| Energy used | `0x3D2` | Lifetime kWh out and in, 1 Wh resolution. Trip energy = Δout − Δin, so regen is included exactly |
| Distance | `0x3B6` | Odometer, 0.001 km |
| Remaining / full pack / buffer | `0x352` | Handles both the pre-2021 layout and the 2021+ multiplexed layout (auto-detected) |
| SOC | `0x292` | Displayed (UI) SOC |
| Rated range | `0x33A` | Rated Wh/mi (dashed chart line) = (remaining − buffer) ÷ rated range. 0x33A's old Wh/mi field is an artifact |
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
| "didn't confirm silent monitoring (ATCSM1)" | The adapter can't promise it won't acknowledge frames on the bus, so the app refuses to listen. Try another adapter |
| vLinker numbers update slowly | Expected: ELM-class adapters rotate through ID groups (~1 s refresh). An OBDLink MX+ streams continuously |

## Files

- `index.html`: layout and styles
- `app.js`: connection, trip math, rendering, CSV
- `elm.js`: adapter link over Web Serial: STN pass filters, or ELM327/vLinker round-robin (`ATCRA` groups, `ATCF`/`ATCM` fallback)
- `decode.js`: CAN signal decoders (usable in Node)
- `coach.js`: pedal/brake efficiency coach and speed-band learning
- `sim.js`: demo frame generator (the **Demo** button)
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline install
- `tests/decode.test.js`, `tests/elm.test.js`: run with `node tests/decode.test.js && node tests/elm.test.js`

Signal layouts come from the community DBC at github.com/joshwardell/model3dbc (MIT) and the 2021+ `0x352` mux layout documented in the Battery-Emulator project. This is unofficial and not affiliated with Tesla.
