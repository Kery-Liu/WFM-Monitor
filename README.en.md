# WFM Market Monitor

**Price watching for warframe.market — market orders and Riven auctions, with an alert the moment your target price is hit.** A Windows tray app: set your price once, stop refreshing the website, and get notified by desktop popup, group bot, or email.

[中文版](./README.md) · Windows 10 / 11 (64-bit) · No account required · All data stays on your PC · Chinese & English UI

---

## What it solves

- Manually refreshing the site cannot catch time-limited deals. This tool polls the API and also uses a WebSocket order stream, and notifies you when a price reaches your target.
- Riven auctions have many filters (positive/negative stats, polarity, re-rolls, mastery rank) that require paging through the website. This tool subscribes to auctions by those conditions and only alerts on matching results.
- warframe.market is hosted overseas; connections can be unstable and hard to diagnose. This tool provides a 7-step network self-check covering proxy, DNS, API, orders, auctions, realtime stream, and rate-limit/breaker state, each with suggested fixes.
- A desktop popup is not received when you are away from the PC. This tool supports Windows notifications, WeCom / DingTalk webhooks, and SMTP email, which can be enabled together.

## Highlights

- Keyword search: `ash prime 一套`, `ash p set`, `沙皇`, `kuva zarr` and similar inputs are matched. Aliases and fuzzy matching return candidates with a confidence score, and the item must be confirmed by clicking.
- Set splitting: after selecting a set, its parts are listed and can be monitored individually.
- Anti-spam: notifications support a trigger cooldown, a re-notify threshold, an hourly cap, and quiet hours.
- Price chart: shows the official 48-hour trading data, with the target price and the historical median on one chart; hover to see price and volume at each point.
- Trade whisper: generates an in-game `/w` message, switching between English and Chinese, and adds the rank for ranked mods.
- Email remote control: sending a mail whose body says `check` runs a full round and returns a price summary.
- Tray resident: closing the window keeps monitoring; a global hotkey can trigger "check all".
- UI and themes: bilingual Chinese/English interface with dark and light themes; item names and market links follow the language.

## Screenshots

| Target detail: best price, orders, 48h trend | New target: search candidates and set parts |
|---|---|
| ![Target detail](docs/screenshots/02-监控详情.png) | ![New target](docs/screenshots/03-新建监控-市场.png) |

| Riven rules: stats, polarity, re-rolls, MR | Network self-check, layer by layer |
|---|---|
| ![Riven rules](docs/screenshots/04-紫卡规则.png) | ![Network self-check](docs/screenshots/06-网络自检.png) |

*The interface ships in both Chinese and English; screenshots above show the Chinese build, and the English UI is available in Settings → Appearance.*

## Install

### Option 1: Installer (recommended)

1. Download the latest installer `WFM-Monitor-Setup-1.0.1.exe` from the Releases page.
2. Run it and pick an install folder (default `%LOCALAPPDATA%\Programs\WFM-Monitor`). **No administrator rights needed.**
3. The app starts automatically; desktop and Start Menu shortcuts are created.
4. On first launch it downloads the item catalog in the background (about 10–30 seconds), then you can search and add targets.

> The installer is not code-signed, so SmartScreen may warn about an "unknown publisher" — choose "Run anyway", or build it yourself from source (see below).

### Option 2: Run from source

Requires Node.js 18+:

```bash
npm install
npm start          # Electron desktop window
# npm run web      # or headless mode at http://127.0.0.1:17890
```

### Uninstall

Remove "WFM 价格监控" from Windows Settings → Apps. Uninstalling keeps your settings and targets; see "Data & privacy" to wipe them.

## Quick start

1. Click **＋ New target**, choose **Market orders** or **Riven auctions**.
2. Type a keyword and **click a candidate** (nothing is saved until you pick one, so lookalike items can't be selected by accident).
3. Set your target price and check interval, then save. That's it.

| You type | It matches |
|---|---|
| `ash prime 一套`, `ash p set` | Ash Prime Set |
| `ash p 图`, `ash prime bp` | Ash Prime Blueprint |
| `沙皇`, `kuva zarr` | Kuva Zarr (Riven weapon) |

Aliases: `p` = prime, `套 / set / 一套` = set, `图 / bp / 蓝图` = blueprint. Each candidate shows a confidence level: `exact` is almost certain; with `weak / none`, read the list before clicking. Searching a weapon's base name suggests switching to its Riven auction.

### Common parameters

| Parameter | Meaning |
|---|---|
| Buy / Sell | Buy watches others' sell orders (lowest ≤ target); Sell watches buy orders (highest ≥ target) |
| Seller scope | `In game` can trade right now; `In game + online` and `All players` widen the net |
| Min. order quantity | Filters out single-unit listings, useful when buying full sets |
| Check interval | Independent per target, 60 seconds by default |
| Confirm rounds | Set to 2 to require two consecutive matches, filtering out flash listings |
| Riven stats | Required positive stats must **all** match; required negative stats match **any one** |
| Polarity / re-roll / MR caps | Hard filters, empty means no limit |
| Pricing | Riven auctions can be judged by buyout or current bid |

## Notifications & quiet time

Enable several channels at once in Settings → Notifications:

- **Windows desktop**: system toast; clicking it jumps to the matching target.
- **WeCom / DingTalk webhook**: paste your group bot URL. If your DingTalk bot requires a custom keyword, fill it in once and every message will include it.
- **Email (SMTP)**: for QQ Mail use `smtp.qq.com:465` with an **app password**, not your login password. Sender equals the account; leave recipients empty to mail yourself.

Use "Send test notification" to verify. Anti-spam: per-target cooldown (600s default), one extra alert if the price drops another 5 platinum during cooldown, 30 messages/hour cap, and quiet hours.

## Three ways to stop — they are different

| Action | Meaning |
|---|---|
| Pause all | Temporarily suspends collection; resuming restores everything, no target's enabled flag is touched |
| Disable one target | Stops only that target, persistently; "check all" and "resume" will not wake it |
| Check all | Immediately checks every **enabled** target and skips disabled ones |

## Network troubleshooting

Open "Network self-check" and run it: proxy config, DNS, API reachability, order API, auction API, realtime stream, and rate-limit/breaker state are tested one by one, each with a cause and a suggested fix. Common codes: `[proxy]` proxy off or wrong address, `[cloudflare]` exit IP flagged, `[rate_limited]` official rate limit exceeded, `[too_many_conn]` too much concurrency.

This tool **only calls the official API (api.warframe.market) and never scrapes web pages**, so normal use does not trigger the site's browser challenge.

## Data & privacy

- Settings, targets, events and price history live only in `%APPDATA%\wfm-monitor\`. No accounts, no telemetry, no uploads.
- Delete that folder for a factory reset, or use Settings → Reset to defaults to clear parameters (including webhook URLs and mail app passwords).
- Prices in notifications are **snapshots taken at read time** — double-check before trading.

## Fair use

warframe.market allows 3 requests/second; this app defaults to 2 and should never be configured below a 340 ms interval. Please respect the site's terms and use it for personal price alerts only. This is an unofficial fan project; Warframe belongs to Digital Extremes and market data to warframe.market.

---

## For developers

Stack: Electron + vanilla HTML/CSS/JS. No frontend framework, no bundler. All logic lives in `src/core`, so another UI can reuse it wholesale.

### What each file does

| Path | Responsibility |
|---|---|
| `src/main/main.js` | Electron main process: window, tray, global hotkey, native notifications, IPC whitelist |
| `src/main/preload.js` | Restricted bridge between renderer and main |
| `src/web/index.html` / `styles.css` | Page skeleton, design scale (radius / type / spacing / shadows) and dark & light theme tokens |
| `src/web/app.js` | All UI logic: cards, forms, chart, settings, dialogs |
| `src/web/i18n.js` / `i18n-dict.js` | Translation engine and the "Chinese source → English" dictionary, shared with main-process notifications |
| `src/web/theme-boot.js` | Paints the first frame correctly to avoid theme flicker |
| `src/core/app.js` | Composition root: wires the layers, exposes a stable API to IPC/HTTP, runs the network self-check |
| `src/core/config.js` | Defaults, config load/save, factory reset |
| `src/core/http/` | Networking: token-bucket rate limiter, concurrency gate, circuit breaker, proxy tunnel, timeout/retry, error classification |
| `src/core/sources/` | Data sources: market orders, Riven auctions, WebSocket stream, cached item catalog |
| `src/core/domain/` | Pure functions: keyword resolution (`resolver.js`) and trigger rules (`rules.js`), no network |
| `src/core/engine/` | Scheduling: global tick (`scheduler.js`) plus a per-target state machine (`monitor.js`), cooldown/dedup and stream dispatch |
| `src/core/notify/` | Notification fan-out: desktop / webhook / email, quiet hours and global throttling |
| `src/core/control/` | Email remote control: IMAP polling, command parsing, reply composer |
| `src/core/store/store.js` | JSON + NDJSON persistence for targets, events, history, runtime state |
| `src/core/errors.js` / `logger.js` / `util.js` | Human-readable errors, in-memory ring log, atomic writes and text normalization |
| `src/server.js` | Headless mode: same core over HTTP |
| `assets/` | Icon and the bundled catalog snapshot (no wait on first launch) |
| `scripts/` | Packaging, factory-state checks, icon generation and regression scripts |

### How to read the code

Dependency direction is fixed: `http → sources → domain → engine → notify / store`; `app.js` assembles everything, while `main` and `web` only present it. Conventions worth keeping:

1. Official API only, never HTML scraping; minimum request interval is 340 ms.
2. The UI never talks to the network directly — go through `core`. Keep `domain` pure and unit-testable.
3. Keyword resolution always returns candidates plus confidence, never a silent rewrite.
4. No SQLite or other native modules; they break Electron packaging via ABI mismatch.
5. "Disabled", "globally paused" and "manual check" are independent states — run the matching regression scripts after touching them.
6. After changing UI copy, run `npm run test:i18n`; it launches the real app and fails on leftover Chinese in the English UI.
7. After changing `src/web/styles.css` or renderer markup, run `npm run test:ui` — 52 assertions cover the type scale, control behaviour, tooltips, tab transitions, themes and overflow.

### Commands

| Command | Purpose |
|---|---|
| `npm start` / `npm run web` | Desktop mode / headless mode |
| `npm run test:realtime` and other `test:*` | Regressions for stream, cooldown, disabling, errors, notifications, remote control |
| `npm run test:update` | v1.0.1 regressions: instant gap refresh, default hotkey, prime part icons, config migration |
| `npm run test:ui` | UI style regressions: scale, control behaviour, themes, no overflow at the minimum window size |
| `npm run audit` | Catalog health check |
| `npm run seed` | Rebuild the bundled catalog snapshot (`assets/catalog.seed.json`) |
| `npm run pack` | builder-free portable folder (`dist/WFM-Monitor-v<version>`) |
| `npm run dist` | Build the NSIS installer into `release/v<version>/`, with a factory-state check first |
| `npm run verify:build` | Verify the output: no personal data, all key files present |

Before packaging, `scripts/preflight-clean.js` hard-fails if runtime files appear in the packaged folders, if the file whitelist includes `data/`-style directories, or if webhook keys / email addresses / passwords are found in the source.

`npm run dist` runs `scripts/build-installer.js`: it reuses the local Electron with trimmed locales, builds the unpacked app, brands the exe with rcedit, generates the NSIS installer, then verifies the output with `verify-build.js`. The result is `release/v<version>/WFM-Monitor-Setup-<version>.exe` (about 73 MB, runtime included — users need no Node.js). No winCodeSign download is required, so packaging also works on Windows machines without administrator rights. Build outputs are versioned per folder, so releases never overwrite each other.

### Changelog

Fixes, root causes and verification for each release live in [CHANGELOG.md](./CHANGELOG.md). Source versions are tagged in git (`v1.0.0`, `v1.0.1`); build outputs go to `dist/WFM-Monitor-v<version>/` and `release/v<version>/`.

### Extension points

- **New notification channel**: add a channel class in `notify/`, defaults in `config.js`, register it in `notify/index.js`, add its settings in `web/app.js`.
- **New target type**: add a source in `sources/`, snapshot and rules in `domain/rules.js`, reuse the existing engine state machine.
- **New remote command**: extend the whitelist regex in `control/commands.js` and add the method in `app.js`.

## License

MIT. For personal learning and market alerts only; not affiliated with Digital Extremes or warframe.market.
