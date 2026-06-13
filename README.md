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

## Cloud sync (optional)

Out of the box the tracker is local-only. Add a free [Supabase](https://supabase.com)
project to sync your collection across devices via email magic-link login:

1. Create a Supabase project.
2. In the **SQL Editor**, run:
   ```sql
   create table if not exists public.collections (
     user_id uuid primary key references auth.users(id) on delete cascade,
     caught  jsonb not null default '[]',
     cards   jsonb not null default '[]',
     updated_at timestamptz not null default now()
   );
   alter table public.collections enable row level security;
   create policy "own row select" on public.collections for select using (auth.uid() = user_id);
   create policy "own row insert" on public.collections for insert with check (auth.uid() = user_id);
   create policy "own row update" on public.collections for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
   ```
3. **Authentication → URL Configuration**: set the Site URL to your deployed
   URL and add both your deployed URL and `http://localhost:4173` to the
   redirect allow-list. (Email magic-link auth is on by default.)
4. **Project Settings → API**: copy the Project URL and the `anon` public key
   into `js/config.js`. Both are safe to expose — row-level security ensures a
   user can only read/write their own row.

When configured, a “Sign in to sync” button appears in the header. Signing in
merges your local data with the cloud (union — nothing is dropped), then keeps
them in sync. Signed out, it falls back to local-only.

## Data

Without cloud sync, everything is stored in `localStorage` under `shiny.*`
keys — no account, no backend. Clearing site data resets the tracker.

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
