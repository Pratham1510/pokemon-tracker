# ✨ Shiny Tracker

A modern, holo-themed Pokémon shiny tracker with a card collection binder and
live market price tracking. No build step, no framework — plain HTML/CSS/JS.

## Run it

Any static server works:

```sh
cd pokemon-shiny-tracker
python3 -m http.server 4173
# open http://localhost:4173
```

## Features

- **Pokédex** — all 1025 Pokémon with shiny sprites (via PokéAPI). Uncaught
  shinies are grayscale; click one to open the detail drawer and mark it
  caught. Search by name or number, filter to caught only. Progress bar in
  the header.
- **Collection** — add/edit/delete the physical cards you own (set, card
  number, rarity, condition, price paid). Cards show paid vs. current market
  value with a gain/loss percentage. "Add as card" from the dex drawer
  prefills the form.
- **Market** — per-card price history with a gradient chart. Log prices
  manually, or link the card to a printing in the
  [Pokémon TCG API](https://pokemontcg.io) and fetch live TCGplayer market
  prices with one click. Each fetch logs a dated price point, so fluctuation
  builds up over time (one TCG point per day; re-fetching updates today's).

## Data

Everything is stored in `localStorage` under `shiny.*` keys — no account, no
backend. Clearing site data resets the tracker.

- Sprites/artwork: [PokéAPI sprites](https://github.com/PokeAPI/sprites) (CDN via raw.githubusercontent.com)
- Names/types: [PokéAPI](https://pokeapi.co) (cached after first load)
- Market prices: [pokemontcg.io](https://pokemontcg.io) v2 API. The API can be
  slow or rate-limited for anonymous traffic, so every request has a 12s
  timeout and automatic retries. For faster, more reliable data, grab a free
  key at [dev.pokemontcg.io](https://dev.pokemontcg.io) and set it via the ⚙
  button in the Market tab (stored in localStorage).
- All prices are shown in **AUD**. TCGplayer market prices arrive in USD and
  are converted at fetch time using the daily USD→AUD rate from
  [frankfurter.app](https://frankfurter.app) (cached per day; manual price
  logs are assumed to already be AUD).
