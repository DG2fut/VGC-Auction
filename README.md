# 🎮 VGC Draft Auction v3

Real-time multiplayer Pokémon VGC draft auction — host locally or deploy to the cloud.

## Requirements
- Node.js v14+ → https://nodejs.org
- That's it — zero dependencies!

---

## Quick Start

```
node server.js
```

The server will:
1. Start at http://localhost:3000
2. Load the Pokémon pool from `pokemon-pool.json`
3. Load Google Sheets credentials if `credentials.json` exists

Deploy to [Render](https://render.com) or any Node.js host for public access.

---

## Admin Accounts

Admin credentials are hardcoded in `server.js` — there is no registration.
Log in via the **Admin** tab on the login screen with one of the pre-configured accounts.

The admin usernames are reserved — regular players cannot use them.

---

## How to Play

### LOBBY
- Only an admin can be the **Host** (crown icon) — the first admin to join gets it
- Admin sets timer, budget, max Pokémon, bid increment, and base prices in Settings
- Share the page URL so others can join
- Late joiners can request to join as players (admin approval required) or watch as **Spectators**

### EACH ROUND
1. The admin nominates a Pokémon — opening bid is set automatically from the tier price
2. Anyone can outbid — the countdown timer resets each time
3. Players can **Pass** to opt out of a round (locked out for that round)
4. When the timer expires (or all players have bid/passed), highest bidder wins

### BUDGET
- Everyone starts with the same budget (default $10,000)
- Bid ceiling enforced: you can't bid more than `budget - ((slots remaining - 1) × lowest tier price)`
- Bids snap to the configured increment ($10 / $25 / $50 / $100)

---

## Admin Controls

| Control | Description |
|---------|-------------|
| Pause / Resume | Freeze or unfreeze the countdown |
| Skip | Cancel bidding, remove Pokémon from pool permanently |
| Hammer | Force-close bidding instantly |
| Undo (Ctrl+Z) | Revert last round |
| Redo (Ctrl+Y) | Re-apply a previously undone round |
| Adjust Budget | Change a player's budget mid-auction |
| Remove Pokémon | Remove a mon from a player's roster (refunds the cost) |
| Non-Participating | Toggle admin out of bidding |
| Restart Auction | Reset rosters/budgets, keep players |
| End Auction | Works from any phase — if mid-bid, awards to highest bidder first |
| New Auction | Full reset |
| Kick Player | Remove inactive/redundant players |
| Remove Spectator | Remove a spectator at any time (visible in spectator bar & lobby) |

---

## Dashboard Tabs

| Tab | Description |
|-----|-------------|
| ⚡ Auction | Live auction view |
| 👥 Teams | View all player rosters with type coverage |
| 📜 History | Browse past auction results |
| 📖 Pokédex | All Pokémon with tiers and types |
| 🗂️ Planner | Build and preview a custom team |
| 🔍 Search | Search players across all auctions |

---

## Settings (admin only, in lobby)

| Setting | Description |
|---------|-------------|
| Auction Name | Custom name for this draft |
| Bid Timer | Seconds before round closes (5–300) |
| Starting Budget | Dollars each player starts with (10–99,999) |
| Max Pokémon | Max mons per player (0 = unlimited) |
| Bid Increment | Bid step size: $10, $25, $50, or $100 |
| Base Prices | Opening bid price per tier (S/A/B/C) |

---

## Customising the Pokémon Pool

Edit **`pokemon-pool.json`** in the project root. The server loads this file on startup — no need to touch `server.js`.

Each entry looks like this:

```json
{ "id": 57, "name": "Flutter Mane", "dex": 987, "type1": "Ghost", "type2": "Fairy", "tier": "S" }
```

| Field | Description |
|-------|-------------|
| `id` | Unique number (must not repeat) |
| `name` | Display name |
| `dex` | National Pokédex number (used for sprite) |
| `spriteId` | *(optional)* Override sprite ID for regional/alternate forms — use the PokeAPI form ID (e.g. `10104` for Ninetales-Alola). Only needed when `dex` alone shows the wrong sprite. |
| `type1` | Primary type |
| `type2` | Secondary type (empty string `""` if none) |
| `tier` | `S`, `A`, `B`, or `C` |

### Finding spriteId for alternate forms

Sprites come from PokeAPI: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{id}.png`

For regional variants and alternate forms, look up the correct ID:
```
https://pokeapi.co/api/v2/pokemon/{form-name}
```
The `id` field in the response is the `spriteId` you need. Examples:

| Pokémon | Form lookup | spriteId |
|---------|------------|----------|
| Ninetales-Alola | `pokemon/ninetales-alola` | 10104 |
| Arcanine-Hisui | `pokemon/arcanine-hisui` | 10230 |
| Rotom-Wash | `pokemon/rotom-wash` | 10009 |
| Weezing-Galar | `pokemon/weezing-galar` | 10167 |

### Swapping the pool for a new auction

1. Stop the server
2. Replace `pokemon-pool.json` with your new pool
3. Delete `data/session.json` to clear the previous auction state
4. Restart the server

---

## Google Sheets Live Logging

The auction can log every nomination, bid, and round result to a Google Sheet in real-time.

### Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Google Sheets API**
4. Go to **Credentials** → **Create Credentials** → **Service Account**
5. Create a key for the service account (JSON format)
6. Download the JSON key file and save it as **`credentials.json`** in the project root
7. Open your Google Sheet and click **Share**
8. Share the sheet with the service account email (found in `credentials.json` as `client_email`) — give **Editor** access
9. Restart the server — you should see `Google Sheets credentials loaded` in the console

The spreadsheet ID is configured in `server.js` (variable `SPREADSHEET_ID`).

### What gets logged

| Type | When | Columns |
|------|------|---------|
| `NOMINATION` | Admin nominates a Pokémon | Round, Pokémon, Tier, Nominated by |
| `BID` | A player places a bid | Round, Pokémon, Bidder, Amount |
| `WON` | Round ends with a winner | Round, Pokémon, Tier, Winner, Final Bid, All Bids, Passed Players |
| `UNSOLD` | Round ends with no bids | Round, Pokémon, Tier |
| `SKIPPED` | Admin skips a Pokémon | Round, Pokémon, Tier |

If `credentials.json` is missing, the server runs normally without Sheets logging.

---

## File Structure

```
├── server.js           # WebSocket server (zero npm dependencies)
├── pokemon-pool.json   # Pokémon pool — edit this for each auction
├── credentials.json    # Google Sheets service account key (gitignored)
├── public/
│   └── index.html      # Single-page client app
├── data/               # Created at runtime (gitignored)
│   ├── session.json    # Persisted auction state
│   ├── admins.json     # Admin account hashes
│   ├── auction-history.json
│   └── auction-logs.json  # Per-round bid logs
└── package.json
```
