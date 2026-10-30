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

## Screen layout

Five tabs: on a phone they sit at the bottom of the screen, on a wider screen across the top (with charge and pack temperature beside them). The last one you used is remembered.

- **Cockpit:** coaching tip, efficiency gauge, power flow, accelerator, mile by mile and the max-range guide.
- **Trip:** this trip and where its energy went (with the range each part cost), the consumption chart (with the window's average and projected range above it), drive history, your speed curve, and **Parked** (below).
- **Battery:** charge and pack readings (including the regen limit and rated range), the charge plan, and a heatmap of all 108 bricks.
- **Health:** prep for the car's battery health test: use the charge down to a target on an out-and-back drive.
- **Setup:** adapter and screen options, alerts, units, theme, Tessie, backup, CSV recording and diagnostics.

**Units (Setup):** Miles (mph, Wh/mi, °F) or Kilometers (km/h, Wh/km, °C). The choice applies to every distance, speed, consumption and temperature on screen, including the coach's tips and drive summaries. Saved data stays in miles, so switching back and forth loses nothing. Distances you type, such as the range goal and the charge plan, are taken in the unit shown. The speed curve keeps its 5-mph bands and shows them in km/h (for example 97–104 km/h). CSV recordings keep their mph and mi columns.

**Theme (Setup):** Match the system (light or dark with the phone), Dark, or Light. The car's screen starts dark, since a light page glares at night.

## Efficiency gauge (Cockpit)

- **Efficiency gauge:** live Wh/mi, smoothed over a few seconds.
  - The arc is green up to your **target**, amber to 1.35× the target, and red beyond.
  - The target is your own best steady-cruise Wh/mi at this speed and outside temperature, or the rated figure until enough data exists. The white tick marks it.
  - The amber dot is your trip average. The badge underneath reads **Efficient**, **A bit heavy** or **Wasting range**.
- **Trip score (0–100, first tile):** the same score drive summaries use.
  - 70% is consumption vs rated: 100 at 15% or more under rated Wh/mi, 0 at 50% or more over.
  - 30% is the share of pedal time spent in the 15–40% range.
- **Tiles:** trip score, range at this pace, average over the last 5/15/30 mi, and charge: % with kWh left and pack temperature. The charge tile is also how Drive view shows the charge.
- **Charging:** the charge tile shows the power going in and when the charge limit will be reached ("Charging 7.0 kW · 80% in 1 h 30 min"), and the gauge reads Charging with the same time. Tessie reports these; from the adapter they're worked out from the energy still to add, so they're marked ~.
- **Power flow bar:** regen to the left of zero, power used to the right, with green "efficient" zones on both sides. The label states it in words, for example "12 kW · efficient" or "35 kW regen · strong, lift earlier".
  - When the car limits regen (cold or nearly full pack), a dashed amber line marks the limit and the label reads "Regen · max 25 kW".

## Range tools (v16–v20)

- **Mile by mile:** each of the last 10 whole miles plus the current one, as bars colored against your target, with a dashed target line.
- **Slowdown capture:** for every slowdown from 15+ mph that loses at least 10 mph with your foot mostly off the pedal, the share of the car's momentum (½·m·v², 1850 kg) that came back as regen.
  - Drag and rolling resistance take some of it, so **60%+ is excellent**.
  - It's reported on the Accelerator card, in the second coaching line right after each slowdown, and in drive summaries.
- **Climate / parked draw chip:** compressor kW, or standby draw while stopped, converted to **miles of range per hour** at your pace.
- **Speed curve:** your learned Wh/mi by speed, with the sweet spot and your current speed marked, plus how far your current charge goes at each speed.
- **Charge plan:** what % to charge to for the miles you need plus an arrival reserve, at your last 7 drives' Wh/mi weighted by distance (so a short hop doesn't skew it), then this trip, then rated.
- **Drive summaries and history:** a score, comparison with rated, slowdown capture, energy breakdown and the one habit to fix, with trends across drives. The last 500 drives are kept on the phone; the list shows 8, and **Show all** lists the rest.
- Slower-changing panels redraw once a second, and only on the tab you're looking at, to keep the phone cool in a mount.

## Battery health test prep (Health tab)

Gets the charge down to a target (20% by default) on an out-and-back drive from home, so you arrive home ready for the car's battery health test.

- **Plan:** from your current charge, the kWh to use and the round-trip miles at your usual Wh/mi (same basis as the charge plan), so you know how far to drive out.
- **Start from home**, then drive. After 2 mi the app uses this drive's own Wh/mi. Some cars report whole percents through Tessie, so between steps the countdown follows the remaining kWh; a reading with decimals is used as is.
  - On the way out, the Cockpit coach shows "66% → 20% · turn around in 12.4 mi · ~14 min". It's time to turn when what's left above the target only just covers the drive back on the same road.
  - Then "Head home · 18.0 mi · ~20 min of driving left until 20%". This doesn't need to know which way you're driving, so turning late just means arriving a little lower.
  - The time is at this outing's pace: your average speed over the last few minutes, stops included. It appears once the car is moving, and the Health tab shows it as **Time at this pace**.
  - At the target: "At 20%: ready for the battery health test".
  - A rising three-tone alert marks the turn-around and the target if eyes-free alerts are on.
  - While prep is on, the eco nags stay quiet: the gauge badge reads "Health test prep", and the pedal and lift-earlier alerts don't fire. Pack warnings still do.
- **Burn faster** (needs your Tessie token, even when the adapter supplies the data):
  - **Climate on full:** AC at LO when it's warm out; HI plus both front seat heaters and the steering wheel heater when it's cold.
  - **Max defrost:** heater and AC together with the fan maxed.
  - **Finish parked:** Camp mode, if you get home above the target.
- Only climate commands are sent. At the target, on Stop, or when the prep clears itself after a day, the app switches off only what it switched on, climate last, and puts the cabin temperature back. It can only do that while the page is open. While a prep runs, Tessie is checked even with the screen off. Chrome may slow that to once a minute, so the target is still caught within about a minute.
  - If the car refuses a command, the card names it and the reason, and nothing after it is sent. A command with no answer after 45 s counts as failed.
  - **Copy diagnostics** lists the last 20 commands and the car's replies.
- Assumes the way back costs about what the way out did. On a route that's mostly downhill going out, you'll arrive a little under the target.
- Demo never sends commands, and a prep tried in Demo is dropped once real data arrives.

## Eyes-free alerts (Setup tab, off by default)

Choose Vibrate, Sound, or both. Each alert fires when a costly habit **starts**, at most once per 15 s per kind, never while the **Cruise / Autopilot** switch is on, and only above 5 mph.

| Signal | Meaning |
|---|---|
| One low tone / short buzz | Ease off: heavy pedal or a sharp lift-off |
| Two high tones / double buzz | Lift earlier: braking with little regen, or regen at its limit |
| Long low tone / long buzz | Pack warning: cold pack under high draw, hot pack, or low charge under high draw |
| Three rising tones / three buzzes | Health test prep: turn around now, or the target is reached. These two always alert while a prep runs, with sound and vibration when alerts are off |

In Tessie mode only the pack warnings can fire: the others need the adapter's pedal and brake data.

Tap **Test alert** once to allow sound (browsers require a tap before audio).

## Max-range guide

Everything below is driven by **your car's own steady-cruise data** (the coach's speed table at the current outside temperature), falling back to rated consumption until enough data exists.

- **Power meter target bands (green):**
  - Up: efficient draw = the power that holding this speed costs you, plus a gentle-acceleration allowance (~0.06 g).
  - Down: gentle regen = up to 60% of the BMS regen limit (35 kW max).
  - The bar turns cyan inside the band, amber above it, and red past about 1.8× the band. Regen past the gentle band turns amber.
- **Right now (Wh/mi)** turns green within 10% of the target for this speed, amber up to 40% over, and red beyond.
- **Range vs rated:** projected range at your pace minus the car's rated range. Positive means you're beating the car's estimate.
- **Best speed:** your most efficient 5-mph band, plus how many miles slowing to it would add right now.
- **Range goal:** tap it and enter the miles you need. It shows the Wh/mi budget to get there, whether you're on budget, the arrival battery %, and if you're over, the speed to slow to (the fastest band in your data that fits the budget). A dotted budget line appears on the chart. Miles count from the first odometer reading after you set it, and the goal clears itself after a day. With Tessie, while the car's navigation has a route, the goal follows it instead (To *destination* · miles left, from the car) and returns to yours when the route ends.
- **Drive view** (header button): shows only the Cockpit with a compact header and larger numbers, and keeps the screen on. The screen only rewrites readings that changed.
  - **Cluster dials:** Drive view (and the car's screen, always) swaps the gauge and power bar for two needle dials, like a car's instrument cluster. The efficiency dial is the same Wh/mi gauge with tick marks and a needle. The speed dial shows your speed in the middle, and its needle is the power bar bent round: regen left of zero, power used to the right, with the same green and blue efficient zones, red past hard acceleration, and a dashed amber mark at the car's regen limit. Under the speed: Wh/mi (or Parked, Charging…) and the power, or the charge's progress while charging.
  - **Status strip:** the header shows the gear (P R N D, the current one lit; all dim when the car doesn't say), the time and the outside temperature.
  - **Charge block:** in place of the tiles, the charge % (amber under 20%, red under 10%) with kWh left and a bar, the range at your current pace (or the rated range until there's a pace) against rated, or the charge's progress while charging. Under it, **This drive**: miles, minutes, Wh/mi and kWh since the car started moving (the same drive the summaries record), and the trip score.
  - **Arrival:** with a route in the car's navigation (Tessie) or a Range goal, the charge you'd arrive with at your current pace (amber under 20%, red under 10%), the car's own estimate beside it, and the destination, miles to go and arrival time. The car's figure assumes typical driving; yours uses how you're actually driving. The destination stays on the device and is masked in Copy diagnostics.
  - **Warnings stand out:** a cold-pack, hot-pack or low-charge warning turns the tip red, bigger, with a ⚠.
  - **Regen limited:** while the car holds regen under 40 kW (cold or nearly full pack; adapter only), that chip takes the Range vs rated slot, with the reason.
  - On a phone mounted sideways, a tablet or computer held wide (900 px or more), and the car's screen, the efficiency dial sits on the left, the Charge block in the middle and the speed dial on the right, with the tip above and the accelerator and guide below. A phone held upright shows the speed dial only, with the Charge block under it.
  - Screens with room (900 × 600 or more: an iPad on its side, the car's screen) get the car's bigger numbers, and the cluster fills the whole screen: the dials grow with its height and the guide sits at the bottom edge. Checked to fit without scrolling from an iPad mini in Safari (about 1133 × 670 visible) up to a 13-inch iPad.

## Range coach

Same rules, thresholds and wording as EcoLab's `RangeCoach` (github.com/vzwjustin/eco, `core/sim/RangeCoach.kt`), so both apps coach the same way. Listen-only. Pedal, brake and slowdown coaching need the adapter; with Tessie the coach gives the tips that don't (speed and drag, pack temperature, charge level, cold air, your own speed data), and Tessie's 10-second readings never teach the speed table.

- **Pedal bar:** green zone **15–40%**, with 1% hysteresis so the color doesn't flicker. Light (<15%) is amber, too much (>40%) is red, and while lifting off it shows the regen being recovered.
- **Uphill exemption:** a heavy pedal that's only holding speed uphill (car's `DI_gradeEst` above 2%, not accelerating) counts as in range.
- **Cue order:** warnings first, then good, then tips. The top cue is the headline, the next one shows underneath, and a "look ahead and coast" reminder is always last. Each line keeps its tip at least 8 s (its numbers still update) and only moves to a tip that has led for 2 s, so a pedal flicking between zones doesn't flip the text. A warning, or shifting into or out of P, switches at once. Demo holds tips in real seconds too.
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
- **Cruise / Autopilot** switch (next to the coaching tip, shown once pedal data is live): the cruise signal isn't on the vehicle bus, so tap it while cruise is holding speed. That turns off pedal coaching and adds the cruise tip.
- Not covered here: EcoLab's wind estimate, tire-pressure, and speed-limit cues. Those frames usually aren't on the OBD vehicle bus.
- **Not validated on a car**, same as EcoLab: the 15–40% zone is a starting estimate.

## Away from the car: Tessie mode

Tap **Start Tessie** (Setup tab) to run the same screen from Tessie's cloud instead of the adapter. Your car streams Fleet Telemetry to Tessie, so pack volts/amps, power and energy remaining refresh about every **10 s** while the car is awake.

- Paste your Tessie API token under **Setup → Tessie API token**. It's stored in that phone's browser only, so never put it in the repo; GitHub Pages repos are public.
- Tessie mode never wakes the car (`use_cache=true`). When the car sleeps, the chip shows how old the last reading is.
- Trip energy in Tessie mode comes from the drop in energy remaining (0.01 kWh steps). Regen and brick voltages aren't available there; bricks need the adapter. Drive summaries say regen needs the adapter rather than showing 0 kWh.
- When Tessie doesn't send the pack's full-charge energy, it's estimated from energy remaining and the charge (from 20% up; shown with ~ on the Battery tab), so the charge plan and health test prep still work.
- Tessie also gives the gear and outside temperature, so drives are scored and summarized in Tessie mode too (without the pedal, slowdown and climate parts), Parked vs Stopped reads right, and the speed table follows the outside temperature.
- Picking another car or pasting a new token forgets the car looked up before, so climate commands and the Parked card go to the car picked.
- Tessie mode keeps its own trip, separate from the adapter's.
- More than one car on the Tessie account: pick it under **Setup → Tessie car** (remembered).

## Parked (Trip tab, needs a Tessie token)

Like the Park view of the car's own Energy app: what the car used while it sat. It reads Tessie's log of parked stretches (`/idles`), which Tessie keeps whether or not this page was open, so it works with the adapter too; Tessie doesn't have to be started. Read-only; fetched while the Trip tab shows, at most every 10 minutes.

- **Latest stretch:** kWh, how long, the average draw in watts, and the share of the time Sentry and climate were on.
- **Last 7 days:** total kWh, per day, and the rated range it cost; then the last six stretches with time and place.
- When the log has stretches with Sentry on the whole time and others with Sentry and climate off, the note compares the car's average draw for each: what Sentry costs this car.

## On the car's touchscreen

Open the same address in the car's browser. The screen runs from Tessie there (about every 10 s): the car's browser most likely can't reach a Bluetooth adapter, though that isn't confirmed yet. To find out, open `check.html` (or **Setup → Diagnostics → Bluetooth check**) on the car's screen with the adapter plugged in: it shows the browser's Chromium version, whether serial and Bluetooth LE exist, and buttons that open the same adapter picker the phone uses. The serial test asks the adapter its name (`ATI`) and closes; nothing is sent to the car. The browser is recognized by its `Tesla/` user agent; add `?car` to the address to try that layout anywhere.

- Tessie starts on its own when the page opens. The first time, it opens Setup for the token (the car's browser keeps its own storage, separate from the phone's). **Connect car** then means Tessie.
- Hidden there, since they need the adapter: the accelerator card, where the energy went, the speed curve, the brick heatmap, and the adapter settings. Drives are scored from Tessie and kept in the car's browser.
- Buttons and tabs get bigger touch targets. Dark by default (**Setup → Theme** to change). The Cockpit shows the cluster dials (see Drive view), and Drive view lays them out side by side.
- Not yet checked on a real car: whether this firmware's browser runs the page (it needs a recent Chromium) and whether it stays usable while driving.

## On an iPad (as a dash display)

Every iPad browser (Safari, Chrome, Firefox) runs on Apple's WebKit engine, which has no Web Serial or Bluetooth, so an iPad can't reach the adapter either: like the car's screen, it runs from Tessie. The same goes for any browser without Web Serial (Firefox on a computer, for one).

- Paste the Tessie token in **Setup** once; after that Tessie starts on its own when the page opens, and **Connect car** means Tessie. Without a token the app says so and Demo still works.
- The adapter-only parts are hidden, as on the car's screen.
- Turn the iPad on its side and tap **Drive view** for the full cluster. For the whole screen with no browser bars, use **Share → Add to Home Screen** and open it from there. **Setup → Theme → Dark** keeps it dark in daylight too.
- Drive view asks to keep the screen on; if the iPad still dims, set **Settings → Display & Brightness → Auto-Lock → Never** while it's mounted.

## Auto-connect (v21)

After you pick the adapter once, Chrome remembers the permission. While the page is open (Drive view on a mounted phone works well) and nothing else is connected, the app tries that adapter:

- on page load,
- whenever Chrome reports the Bluetooth adapter in range,
- every 15 s,
- and again when you switch back to the tab.

The chip shows **Looking for the adapter…** until the car powers the OBD port.

- **Disconnect** pauses auto-connect until you tap **Connect car** again. You can turn it off under Setup.
- If the Bluetooth link drops mid-drive, it reconnects quietly the same way, keeping the trip.
- Picking an adapter with **Choose adapter** (Setup tab) makes Chrome forget the other adapters it had permission for, so auto-connect can't open the wrong one (Web Serial can't tell two Bluetooth serial adapters apart). Choose adapter still lists them all.
- **Limit:** Chrome can't connect while the page is closed or in the background. Web pages can't run Bluetooth in the background, so open the app (or keep it as the home-screen app) when you get in.
  - Once connected, switching to Maps can make Chrome slow the page's timers to once a minute. The adapter's frames then drive the trip math instead, so the energy breakdown and moving time keep counting as long as frames keep arriving.
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
- **Trip** splits energy into driving, parked (odometer not moving), regen recovered and charging added. It saves to the phone and survives reconnects until you tap **Reset trip** (twice, to confirm).
- **Bricks:** lowest, highest, spread, a watched brick (default **38**) and its gap to the lowest of the other 107. The gap turns amber below −5 mV and red below −20 mV. The heatmap shades each brick by voltage within the current spread and marks bricks 5+ mV (amber) or 20+ mV (red) under the middle brick. Tap a brick to watch it.
  - **Spread, parked:** the spread after 10 s parked with almost no current. While driving, bricks are read a few at a time as the current changes, so the live spread mixes moments; the parked figure is the one that shows balance.
  - **Under load:** how many mV more the watched brick sags per 100 A than the two bricks reported in the same CAN frame. Those three are read at the same moment and the same current, so the difference is the watched brick's extra resistance. It needs one firm acceleration (current spanning 100 A) and starts fresh each session or when you watch another brick. Healthy neighbors match within a few mV; it turns amber from +5 and red from +15.

## Record CSV

Tap **Record CSV** to log one row per second: speed, power, V/A, odometer, kWh counters, SOC, energy remaining, full pack, min/max brick, watched brick, and pack temps. Tap again to stop, then tap **Download CSV**. Logging keeps the last 10 hours of rows.

Rows are also saved on the phone as you go, so if the page reloads or Android closes the tab, the recording comes back as **Download CSV** the next time you open the app.

## Backup

Drives, the learned speed table and trips are stored in Chrome on this phone only. The app asks Chrome not to clear that storage, and **Setup → Export backup** saves it to a file. **Import backup** (tap twice) restores a backup on this or another phone, then reloads. Settings are included: watched brick, alerts, units, charge plan, health-prep target, keep-awake and auto-connect. The range goal, an ongoing health prep and the Tessie token are not.

## Verify on your car (first drive checklist)

- [ ] **Brick numbering:** compare the watched brick with Scan My Tesla once. If it's off by one, switch **Setup → Brick numbering** to 0–107.
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

- `index.html`: layout and styles, with the icons inlined (Lucide, ISC license) so it works offline
- `app.js`: connection, trip math, rendering, CSV
- `elm.js`: adapter link over Web Serial: STN pass filters, or ELM327/vLinker round-robin (`ATCRA` groups, `ATCF`/`ATCM` fallback)
- `decode.js`: CAN signal decoders (usable in Node)
- `coach.js`: pedal/brake efficiency coach and speed-band learning
- `sim.js`: demo frame generator (the **Demo** button)
- `sw.js`, `manifest.webmanifest`, `icon.svg`, `icon-maskable.svg`: offline install. The service worker fetches fresh files first but serves the saved copy if the network hangs for 3 s or answers with an error.
- `tests/`: run with `npm test` (`app.test.js` boots `app.js` on a stub page against a fake adapter and a fake Tessie). GitHub Actions runs them on every push.
- `tools/bump.js`: `npm run bump` raises the version in `sw.js` and `index.html` for a release

Signal layouts come from the community DBC at github.com/joshwardell/model3dbc (MIT) and the 2021+ `0x352` mux layout documented in the Battery-Emulator project. This is unofficial and not affiliated with Tesla.
