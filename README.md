# 🎮 VGC Draft Auction v3

Real-time multiplayer Pokémon VGC draft auction — host locally, play over the internet.

## Requirements
- Node.js v14+ → https://nodejs.org
- That's it! Internet tunneling is built-in.

---

## Quick Start

```
node server.js
```

The server will:
1. Start at http://localhost:3000
2. Automatically create a public URL via localtunnel
3. Print the **admin setup code** and public URL in the terminal

---

## First-Time Admin Setup

1. Run the server — it will print an **Admin Setup Code** in the terminal
2. Open http://localhost:3000
3. Click the **Register** tab on the login screen
4. Enter a username, password, and the setup code
5. You're now registered as an admin — log in via the **Admin** tab

Multiple admins can register using the same setup code.

---

## How to Play

### LOBBY
- First admin to join becomes the **Host** (crown icon)
- Admin sets timer, budget, max Pokémon, and base prices in Settings
- Share the page URL so others can join
- Late joiners automatically become **Spectators**

### EACH ROUND
1. Any player picks a Pokémon from the pool and sets an opening bid
2. Anyone can outbid — the countdown timer resets each time
3. Players can **Pass** to opt out of a round
4. When the timer expires, highest bidder wins

### BUDGET
- Everyone starts with the same budget (default $100)
- You cannot bid more than your remaining dollars
- A **max Pokémon** cap can be set (default 6)

---

## Admin Controls

| Control | Description |
|---------|-------------|
| Pause / Resume | Freeze or unfreeze the countdown |
| Skip | Cancel bidding, return Pokémon to pool |
| Hammer | Force-close bidding instantly |
| Undo (Ctrl+Z) | Revert last round |
| Redo (Ctrl+Y) | Re-apply a previously undone round |
| Restart Auction | Reset rosters/budgets, keep players |
| End Auction | Save results and show final rosters |
| New Auction | Full reset |
| Kick Player | Remove inactive/redundant players |

---

## Dashboard Tabs

| Tab | Description |
|-----|-------------|
| ⚡ Auction | Live auction view |
| 👥 Teams | View all player rosters |
| 📜 Draft History | Browse past auction results |
| 📖 Pokédex | All Pokémon with tiers and types |
| 🗂️ Team Planner | Build and preview a custom team |
| 🔍 Player Search | Search players across all auctions |

---

## Settings (admin only, before starting)

| Setting | Description |
|---------|-------------|
| Auction Name | Custom name for this draft |
| Bid Timer | Seconds of silence before round closes (5-300) |
| Starting Budget | Dollars each player starts with (10-9999) |
| Max Pokémon | Max mons per player (0 = unlimited) |
| Base Prices | Starting bid price per tier (S/A/B/C) |

---

## Customising the Pokémon Pool

Edit the `POKEMON_POOL` array in `server.js`:

```js
{ id:57, name:'Flutter Mane', dex:987, type1:'Ghost', type2:'Fairy', tier:'S' }
```

- `id` — unique number
- `name` — display name
- `dex` — National Dex number (used for sprite)
- `type1` / `type2` — types (use empty string if none)
- `tier` — S, A, B, or C
