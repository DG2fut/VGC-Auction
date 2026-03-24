# 🎮 VGC Draft Auction v2

Real-time multiplayer Pokémon VGC draft auction — host locally, play over the internet.

## Requirements
- Node.js v14+ → https://nodejs.org
- That's it! Internet tunneling is built in (no accounts, no extra tools).

---

## Quick Start

  node server.js

The server will start locally at http://localhost:3000

---

## Internet Play

No extra setup needed. Just run the server on a web/game hosting service and play with your friends. 

---

## How to Play

LOBBY
- First player to join is the Host (crown icon)
- Host sets timer and budget in the Settings panel
- Share the page URL so others can join (no player limit)
- Host clicks Start Auction when ready

EACH ROUND
1. Any player picks a Pokemon from the pool and sets an opening bid
2. Anyone can outbid — the countdown timer resets each time someone bids
3. When the timer expires with no new bid, highest bidder wins
4. If nobody bids, Pokemon goes unsold and returns to the pool

BUDGET
- Everyone starts with the same budget (configurable, default 100cr)
- You cannot bid more than your remaining credits

---

## Host Controls

  Pause / Resume   Freeze or unfreeze the countdown timer
  Skip             Cancel bidding, return Pokemon to pool
  Hammer           Force-close bidding instantly, award current top bid
  Undo (Ctrl+Z)    Revert last round — restores budgets and rosters
  Redo (Ctrl+Y)    Re-apply a previously undone round
  End Auction      Show final rosters
  New Auction      Full reset

---

## Settings (host only, before starting)

  Bid Timer        Seconds of silence before round closes (5-300, default 30)
  Starting Budget  Credits each player starts with (10-9999, default 100)

---

## Customising the Pokemon Pool

Edit the POKEMON_POOL array in server.js:

  { id:57, name:'Flutter Mane', dex:987, type1:'Ghost', type2:'Fairy', tier:'S' }

  id    - unique number
  name  - display name
  dex   - National Dex number (used for sprite image)
  type1 - primary type
  type2 - secondary type (use empty string if none)
  tier  - S, A, B, or C
