/* ============================================================
   SHINY TRACKER — app logic
   Data: PokéAPI (dex + sprites), pokemontcg.io (market prices)
   Persistence: localStorage
   ============================================================ */

const TOTAL_POKEMON = 1025;
const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const TCG_API = 'https://api.pokemontcg.io/v2';

const KEYS = {
  caught: 'shiny.caught.v1',
  collection: 'shiny.collection.v1',
  names: 'shiny.names.v1',
  sets: 'shiny.sets.v1',
  apiKey: 'shiny.tcgApiKey.v1',
  fx: 'shiny.fxAud.v1',
};

const state = {
  names: [],                  // index 0 => pokemon #1
  caught: new Set(),          // dex numbers caught as shiny
  collection: [],             // card objects
  selectedDex: 1,
  selectedCardId: null,
  view: 'dex',
  editingCardId: null,
  detailCache: new Map(),     // dexNum -> {types,height,weight}
};

const $ = (sel) => document.querySelector(sel);
const fmt$ = (n) => 'A$' + Number(n).toFixed(2);
const todayISO = () => new Date().toISOString().slice(0, 10);

/* ---------------- USD→AUD exchange rate ----------------
   TCGplayer market prices are USD; everything in the app is shown and
   stored in AUD. Live rate from frankfurter.app, cached for the day. */

let fxRate = 1.55; // fallback if offline and nothing cached
const usdToAud = (usd) => usd * fxRate;

async function loadFx() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEYS.fx) || 'null'); } catch { /* ignore */ }
  if (cached?.rate) fxRate = cached.rate;
  if (cached?.date === todayISO()) return;
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD');
    const d = await res.json();
    if (d?.rates?.AUD) {
      fxRate = d.rates.AUD;
      localStorage.setItem(KEYS.fx, JSON.stringify({ rate: fxRate, date: todayISO() }));
    }
  } catch { /* keep cached/fallback rate */ }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------------- persistence ---------------- */

function load() {
  try {
    state.caught = new Set(JSON.parse(localStorage.getItem(KEYS.caught) || '[]'));
    state.collection = JSON.parse(localStorage.getItem(KEYS.collection) || '[]');
    state.names = JSON.parse(localStorage.getItem(KEYS.names) || '[]');
  } catch { /* corrupted storage — start fresh */ }
}
function saveCaught() {
  localStorage.setItem(KEYS.caught, JSON.stringify([...state.caught]));
  cloudPush();
}
function saveCollection() {
  localStorage.setItem(KEYS.collection, JSON.stringify(state.collection));
  cloudPush();
}

/* ---------------- cloud sync (Supabase) ----------------
   localStorage is always the local cache. When the user is signed in, the
   same {caught, cards} payload is mirrored to a per-user row in Supabase so
   their collection follows them across devices. Everything degrades to
   local-only mode when Supabase isn't configured or the user is signed out. */

let supa = null;        // Supabase client (null = local-only mode)
let session = null;     // current auth session
let pushTimer = null;
let pulling = false;
let syncedUserId = null;

const cloudEnabled = () => !!supa;
const loggedIn = () => !!session?.user;

function initSupabase() {
  const url = window.SHINY_SUPABASE_URL;
  const key = window.SHINY_SUPABASE_ANON_KEY;
  if (!url || !key || !window.supabase) return; // stay in local-only mode
  supa = window.supabase.createClient(url, key);
}

function setSyncDot(cls) { // '', 'syncing', 'error'
  const dot = $('#sync-dot');
  if (!dot) return;
  dot.className = 'sync-dot' + (cls ? ' ' + cls : '');
  dot.title = cls === 'syncing' ? 'Syncing…' : cls === 'error' ? 'Sync error' : 'Synced';
}

function renderAuthUI() {
  const signinBtn = $('#btn-signin');
  const chip = $('#account-chip');
  if (!cloudEnabled()) { signinBtn.classList.add('hidden'); chip.classList.add('hidden'); return; }
  if (loggedIn()) {
    signinBtn.classList.add('hidden');
    chip.classList.remove('hidden');
    $('#account-email').textContent = session.user.email;
  } else {
    signinBtn.classList.remove('hidden');
    chip.classList.add('hidden');
  }
}

function cloudPush() {
  if (!loggedIn()) return;
  setSyncDot('syncing');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const { error } = await supa.from('collections').upsert({
        user_id: session.user.id,
        caught: [...state.caught],
        cards: state.collection,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      setSyncDot('');
    } catch (e) {
      setSyncDot('error');
      console.warn('cloud push failed:', e.message || e);
    }
  }, 700);
}

// On sign-in, union local + cloud so syncing never silently drops progress.
async function cloudPullMerge() {
  if (pulling || !loggedIn()) return;
  if (syncedUserId === session.user.id) return; // already synced this session
  pulling = true;
  setSyncDot('syncing');
  try {
    const { data, error } = await supa.from('collections')
      .select('caught,cards').eq('user_id', session.user.id).maybeSingle();
    if (error) throw error;

    // caught: union of dex numbers
    state.caught = new Set([...((data && data.caught) || []), ...state.caught]);
    // cards: union by id, cloud copy wins on conflict
    const byId = new Map();
    for (const c of state.collection) byId.set(c.id, c);
    for (const c of ((data && data.cards) || [])) byId.set(c.id, c);
    state.collection = [...byId.values()];

    syncedUserId = session.user.id;
    saveCaught();      // write local cache + schedule a push of the merged state
    saveCollection();
    refreshDexCells();
    renderCollection();
    renderMarket();
    updateHeaderStats();
    toast('☁ Collection synced.');
  } catch (e) {
    setSyncDot('error');
    console.warn('cloud pull failed:', e.message || e);
    toast('Sync failed — working locally for now.');
  } finally {
    pulling = false;
  }
}

async function sendMagicLink(email) {
  const { error } = await supa.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

async function passwordSignIn(email, password) {
  const { error } = await supa.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function passwordSignUp(email, password) {
  const { data, error } = await supa.auth.signUp({ email, password });
  if (error) throw error;
  return data; // data.session is set when email confirmation is disabled
}

function wireAuth() {
  renderAuthUI();
  if (!cloudEnabled()) return;
  supa.auth.onAuthStateChange((event, sess) => {
    session = sess;
    if (event === 'SIGNED_OUT') { syncedUserId = null; toast('Signed out.'); }
    if (event === 'SIGNED_IN') $('#signin-overlay').classList.add('hidden');
    renderAuthUI();
    if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && sess?.user) {
      cloudPullMerge();
    }
  });
}

/* ---------------- sprite helpers ---------------- */

const shinySprite = (n) => `${SPRITES}/shiny/${n}.png`;
const normalSprite = (n) => `${SPRITES}/${n}.png`;
const shinyArt = (n) => `${SPRITES}/other/official-artwork/shiny/${n}.png`;
const normalArt = (n) => `${SPRITES}/other/official-artwork/${n}.png`;

function nameOf(n) {
  return state.names[n - 1] || `pokemon #${n}`;
}

/* ---------------- toast ---------------- */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ============================================================
   POKÉDEX
   ============================================================ */

async function loadNames() {
  if (state.names.length >= TOTAL_POKEMON) return;
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon?limit=${TOTAL_POKEMON}`);
    const data = await res.json();
    state.names = data.results.map(r => r.name);
    localStorage.setItem(KEYS.names, JSON.stringify(state.names));
    document.querySelectorAll('.dex-cell').forEach(cell => {
      const n = Number(cell.dataset.num);
      cell.querySelector('.dex-name').textContent = nameOf(n);
    });
  } catch {
    toast('Offline? Pokémon names unavailable.');
  }
}

function buildDexGrid() {
  const grid = $('#dex-grid');
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= TOTAL_POKEMON; n++) {
    const cell = document.createElement('div');
    cell.className = 'dex-cell';
    cell.dataset.num = n;
    cell.innerHTML = `
      <img loading="lazy" alt="" src="${normalSprite(n)}"
           onerror="this.onerror=null;this.src='${shinySprite(n)}'">
      <span class="dex-name">${nameOf(n)}</span>
      <span class="dex-num">#${String(n).padStart(4, '0')}</span>`;
    cell.addEventListener('click', () => {
      selectDex(n);
      openDrawer();
    });
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
  refreshDexCells();
}

function refreshDexCells() {
  document.querySelectorAll('.dex-cell').forEach(cell => {
    const n = Number(cell.dataset.num);
    cell.classList.toggle('caught', state.caught.has(n));
    cell.classList.toggle('selected', n === state.selectedDex);
  });
  applyDexFilter();
  updateHeaderStats();
}

function applyDexFilter() {
  const q = $('#dex-search').value.trim().toLowerCase();
  const caughtOnly = $('#dex-caught-only').checked;
  document.querySelectorAll('.dex-cell').forEach(cell => {
    const n = Number(cell.dataset.num);
    const name = nameOf(n);
    const matches = !q || name.includes(q) || String(n) === q.replace(/^#0*/, '');
    const visible = matches && (!caughtOnly || state.caught.has(n));
    cell.style.display = visible ? '' : 'none';
  });
}

function selectDex(n) {
  const prev = document.querySelector(`.dex-cell[data-num="${state.selectedDex}"]`);
  prev?.classList.remove('selected');
  state.selectedDex = n;
  const cur = document.querySelector(`.dex-cell[data-num="${n}"]`);
  cur?.classList.add('selected');
  renderDrawer();
}

function toggleCaught(n) {
  if (state.caught.has(n)) state.caught.delete(n);
  else state.caught.add(n);
  saveCaught();
  const cell = document.querySelector(`.dex-cell[data-num="${n}"]`);
  cell?.classList.toggle('caught', state.caught.has(n));
  applyDexFilter();
  updateHeaderStats();
  renderDrawer();
  toast(state.caught.has(n) ? `✨ ${cap(nameOf(n))} marked shiny!` : `${cap(nameOf(n))} unmarked.`);
}

async function fetchDetails(n) {
  if (state.detailCache.has(n)) return state.detailCache.get(n);
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${n}`);
    const d = await res.json();
    const info = {
      types: d.types.map(t => t.type.name),
      height: d.height / 10,
      weight: d.weight / 10,
    };
    state.detailCache.set(n, info);
    return info;
  } catch { return null; }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------------- detail drawer ---------------- */

function openDrawer() { $('#detail-drawer').classList.add('open'); renderDrawer(); }
function closeDrawer() { $('#detail-drawer').classList.remove('open'); }

async function renderDrawer() {
  if (!$('#detail-drawer').classList.contains('open')) return;
  const n = state.selectedDex;
  const caught = state.caught.has(n);
  const body = $('#drawer-body');
  body.innerHTML = `
    <div class="drawer-art-wrap">
      <img class="drawer-art ${caught ? '' : 'uncaught'}" src="${normalArt(n)}"
           onerror="this.onerror=null;this.src='${shinyArt(n)}'" alt="${nameOf(n)}">
    </div>
    <h2 class="drawer-title">${nameOf(n)}</h2>
    <div class="drawer-sub">#${String(n).padStart(4, '0')}</div>
    <div class="type-chips" id="drawer-types"></div>
    <div class="caught-state ${caught ? 'is-caught' : ''}">
      ${caught ? '✦ Shiny caught! ✦' : 'Not caught yet'}
    </div>
    <div class="drawer-actions">
      <button class="btn ${caught ? '' : 'btn-holo'}" id="drawer-toggle">
        ${caught ? 'Unmark shiny' : '✨ Mark shiny caught'}
      </button>
      <button class="btn" id="drawer-add-card">+ Add as card to collection</button>
    </div>`;
  $('#drawer-toggle').addEventListener('click', () => toggleCaught(n));
  $('#drawer-add-card').addEventListener('click', () => {
    openCardForm(null, { name: cap(nameOf(n)), dexNum: n });
  });

  const info = await fetchDetails(n);
  if (info && state.selectedDex === n) {
    $('#drawer-types').innerHTML = info.types
      .map(t => `<span class="type-chip">${t}</span>`).join('');
  }
}

/* ============================================================
   COLLECTION
   ============================================================ */

function currentPrice(card) {
  const h = card.priceHistory;
  return h.length ? h[h.length - 1].price : null;
}

function cardSpriteSrc(card) {
  if (card.tcgImage) return card.tcgImage;
  if (card.dexNum) return shinySprite(card.dexNum);
  return normalSprite(25); // fallback: pikachu silhouette-ish placeholder
}

function renderCollection() {
  const grid = $('#collection-grid');
  const cards = state.collection;
  $('#collection-count').textContent = cards.length;
  $('#collection-empty').classList.toggle('hidden', cards.length > 0);
  grid.innerHTML = '';

  for (const card of cards) {
    const price = currentPrice(card);
    const paid = card.paid != null && card.paid !== '' ? Number(card.paid) : null;
    let deltaHtml = '';
    if (price != null && paid != null && paid > 0) {
      const diff = price - paid;
      const pct = (diff / paid) * 100;
      deltaHtml = `<span class="delta ${diff >= 0 ? 'up' : 'down'}">
        ${diff >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>`;
    }
    const el = document.createElement('div');
    el.className = 'holo-card' + (card.id === state.selectedCardId ? ' selected' : '');
    el.innerHTML = `
      <div class="card-top">
        <img class="card-sprite" src="${cardSpriteSrc(card)}" alt=""
             onerror="this.style.visibility='hidden'">
        <div>
          <div class="card-title">${esc(card.name)}</div>
          <div class="card-set">${esc(card.set || 'Unknown set')}${card.number ? ' · #' + esc(card.number) : ''}</div>
        </div>
      </div>
      <div class="card-tags">
        <span class="tag rarity">${esc(card.rarity)}</span>
        <span class="tag">${esc(card.condition)}</span>
        ${card.tcgId ? '<span class="tag">TCG linked</span>' : ''}
      </div>
      <div class="card-money">
        <div class="money-block">
          <div class="m-label">Paid</div>
          <div class="m-val">${paid != null ? fmt$(paid) : '—'}</div>
        </div>
        <div class="money-block" style="text-align:right">
          <div class="m-label">Market ${deltaHtml}</div>
          <div class="m-val holo-text">${price != null ? fmt$(price) : '—'}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-sm act-track">📈 Track</button>
        <button class="btn btn-sm act-edit">Edit</button>
        <button class="btn btn-sm btn-danger act-del">Delete</button>
      </div>`;

    el.querySelector('.act-track').addEventListener('click', (e) => {
      e.stopPropagation();
      state.selectedCardId = card.id;
      switchView('market');
    });
    el.querySelector('.act-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openCardForm(card.id);
    });
    el.querySelector('.act-del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${card.name}" from your collection?`)) deleteCard(card.id);
    });
    el.addEventListener('click', () => {
      state.selectedCardId = card.id;
      renderCollection();
    });
    grid.appendChild(el);
  }
  updateHeaderStats();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function deleteCard(id) {
  state.collection = state.collection.filter(c => c.id !== id);
  if (state.selectedCardId === id) state.selectedCardId = null;
  saveCollection();
  renderCollection();
  renderMarket();
  toast('Card deleted.');
}

/* ---------------- set autocomplete ---------------- */

let tcgSets = [];          // [{name, series, releaseDate}]
let setsLoading = null;

function loadSets() {
  if (tcgSets.length || setsLoading) return setsLoading;
  const cached = localStorage.getItem(KEYS.sets);
  if (cached) {
    try { tcgSets = JSON.parse(cached); return Promise.resolve(); } catch { /* refetch */ }
  }
  setsLoading = tcgFetch('/sets?pageSize=250&select=name,series,releaseDate&orderBy=-releaseDate')
    .then(d => {
      tcgSets = (d.data || []).map(s => ({ name: s.name, series: s.series, releaseDate: s.releaseDate }));
      localStorage.setItem(KEYS.sets, JSON.stringify(tcgSets));
    })
    .catch(() => { /* offline — fall back to sets already used in the collection */ })
    .finally(() => { setsLoading = null; });
  return setsLoading;
}

function setSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const source = tcgSets.length
    ? tcgSets
    : [...new Set(state.collection.map(c => c.set).filter(Boolean))].map(name => ({ name, series: '' }));
  return source.filter(s => s.name.toLowerCase().includes(q)).slice(0, 8);
}

function wireSetAutocomplete() {
  const input = $('#cf-set');
  const list = $('#cf-set-ac');
  let activeIdx = -1;
  let currentMatches = [];

  const close = () => { list.classList.add('hidden'); list.innerHTML = ''; activeIdx = -1; currentMatches = []; };

  const highlight = (name, q) => {
    const i = name.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
  };

  const render = () => {
    const q = input.value;
    currentMatches = setSuggestions(q);
    if (!currentMatches.length) { close(); return; }
    list.innerHTML = '';
    currentMatches.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'ac-item' + (i === activeIdx ? ' active' : '');
      item.innerHTML = `<span>${highlight(s.name, q.trim())}</span>` +
        (s.series ? `<span class="ac-sub">${esc(s.series)}</span>` : '');
      // mousedown (not click) so it fires before the input's blur
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = s.name;
        close();
      });
      list.appendChild(item);
    });
    list.classList.remove('hidden');
  };

  input.addEventListener('input', () => {
    activeIdx = -1;
    const p = loadSets();
    if (p) p.then(() => { if (input.value.trim()) render(); }); // re-render once sets arrive
    render();
  });
  input.addEventListener('focus', () => { loadSets(); if (input.value.trim()) render(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.ac-item');
    if (list.classList.contains('hidden') || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = e.key === 'ArrowDown'
        ? (activeIdx + 1) % items.length
        : (activeIdx - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      items[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault(); // don't submit the form while picking
      input.value = currentMatches[activeIdx]?.name ?? input.value;
      close();
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // keep the modal open, just close the dropdown
      close();
    }
  });
}

/* ---------------- card form ---------------- */

function openCardForm(cardId, prefill) {
  loadSets(); // warm up set suggestions while the user fills the form
  state.editingCardId = cardId;
  const card = cardId ? state.collection.find(c => c.id === cardId) : null;
  $('#card-form-title').textContent = card ? 'Edit card' : 'Add card';
  $('#cf-name').value = card?.name ?? prefill?.name ?? '';
  $('#cf-set').value = card?.set ?? '';
  $('#cf-number').value = card?.number ?? '';
  $('#cf-rarity').value = card?.rarity ?? 'Holo Rare';
  $('#cf-condition').value = card?.condition ?? 'Near Mint';
  $('#cf-paid').value = card?.paid ?? '';
  $('#cf-dexnum').value = card?.dexNum ?? prefill?.dexNum ?? '';
  $('#card-form-overlay').classList.remove('hidden');
  $('#cf-name').focus();
}

function closeCardForm() {
  $('#card-form-overlay').classList.add('hidden');
  state.editingCardId = null;
}

function submitCardForm(e) {
  e.preventDefault();
  const data = {
    name: $('#cf-name').value.trim(),
    set: $('#cf-set').value.trim(),
    number: $('#cf-number').value.trim(),
    rarity: $('#cf-rarity').value,
    condition: $('#cf-condition').value,
    paid: $('#cf-paid').value === '' ? null : Number($('#cf-paid').value),
    dexNum: $('#cf-dexnum').value === '' ? null : Number($('#cf-dexnum').value),
  };
  if (!data.name) return;

  if (state.editingCardId) {
    const card = state.collection.find(c => c.id === state.editingCardId);
    Object.assign(card, data);
    toast('Card updated.');
  } else {
    const card = { id: uid(), ...data, tcgId: null, tcgImage: null, priceHistory: [] };
    if (data.paid != null) {
      card.priceHistory.push({ date: todayISO(), price: data.paid, source: 'manual' });
    }
    state.collection.push(card);
    state.selectedCardId = card.id;
    toast(`"${data.name}" added to your binder!`);
  }
  saveCollection();
  closeCardForm();
  renderCollection();
  renderMarket();
}

/* ============================================================
   MARKET
   ============================================================ */

function selectedCard() {
  return state.collection.find(c => c.id === state.selectedCardId)
      || state.collection[0] || null;
}

function renderMarket() {
  const hasCards = state.collection.length > 0;
  $('#market-empty').classList.toggle('hidden', hasCards);
  $('#market-body').classList.toggle('hidden', !hasCards);
  $('#market-card-select').classList.toggle('hidden', !hasCards);
  $('#btn-link-tcg').classList.toggle('hidden', !hasCards);
  $('#btn-refresh-price').classList.toggle('hidden', !hasCards);
  if (!hasCards) return;

  const card = selectedCard();
  state.selectedCardId = card.id;

  const sel = $('#market-card-select');
  sel.innerHTML = state.collection
    .map(c => `<option value="${c.id}" ${c.id === card.id ? 'selected' : ''}>${esc(c.name)}${c.set ? ' — ' + esc(c.set) : ''}</option>`)
    .join('');

  // chart meta
  const h = card.priceHistory;
  const cur = currentPrice(card);
  $('#chart-current').textContent = cur != null ? fmt$(cur) : '—';
  const changeEl = $('#chart-change');
  changeEl.className = 'muted';
  if (h.length >= 2) {
    const prev = h[h.length - 2].price;
    const diff = cur - prev;
    const pct = prev > 0 ? (diff / prev) * 100 : 0;
    changeEl.textContent = `${diff >= 0 ? '▲' : '▼'} ${fmt$(Math.abs(diff))} (${Math.abs(pct).toFixed(1)}%)`;
    changeEl.className = diff >= 0 ? 'up' : 'down';
  } else {
    changeEl.textContent = 'log more prices to see change';
  }

  $('#tcg-link-info').textContent = card.tcgId
    ? `Linked to TCG card: ${card.tcgName} (${card.tcgId})`
    : 'Not linked to a TCG card yet — link one to fetch live market prices.';

  // log
  const log = $('#price-log');
  log.innerHTML = h.length ? '' : '<div class="tcg-status">No prices logged yet.</div>';
  [...h].reverse().forEach((entry, ri) => {
    const idx = h.length - 1 - ri;
    const row = document.createElement('div');
    row.className = 'price-entry';
    row.innerHTML = `
      <span class="p-date">${entry.date}</span>
      <span class="p-src ${entry.source}">${entry.source}</span>
      <span class="p-val">${fmt$(entry.price)}</span>
      <button class="p-del" title="Remove entry">✕</button>`;
    row.querySelector('.p-del').addEventListener('click', () => {
      card.priceHistory.splice(idx, 1);
      saveCollection();
      renderMarket();
      renderCollection();
    });
    log.appendChild(row);
  });

  drawChart(card);
}

/* ---------------- chart ---------------- */

function drawChart(card) {
  const canvas = $('#price-chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, hgt = canvas.clientHeight;
  if (!w) return;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, hgt);

  const pts = [...card.priceHistory].sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length === 0) {
    ctx.fillStyle = 'rgba(138,147,184,.7)';
    ctx.font = '13px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No price data yet — log a price or fetch one from the TCG API', w / 2, hgt / 2);
    return;
  }

  const pad = { l: 46, r: 14, t: 14, b: 26 };
  const prices = pts.map(p => p.price);
  let min = Math.min(...prices), max = Math.max(...prices);
  if (min === max) { min = min * 0.9 - 1; max = max * 1.1 + 1; }
  const span = max - min;
  min -= span * 0.08; max += span * 0.08;

  const X = (i) => pts.length === 1
    ? w / 2
    : pad.l + (i / (pts.length - 1)) * (w - pad.l - pad.r);
  const Y = (p) => pad.t + (1 - (p - min) / (max - min)) * (hgt - pad.t - pad.b);

  // gridlines + labels
  ctx.strokeStyle = 'rgba(126,138,200,.15)';
  ctx.fillStyle = 'rgba(138,147,184,.8)';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const val = min + ((max - min) * g) / 4;
    const y = Y(val);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText('A$' + val.toFixed(val >= 100 ? 0 : 2), pad.l - 6, y + 3);
  }

  // x labels (first / last date)
  ctx.textAlign = 'left';
  ctx.fillText(pts[0].date, pad.l, hgt - 8);
  if (pts.length > 1) {
    ctx.textAlign = 'right';
    ctx.fillText(pts[pts.length - 1].date, w - pad.r, hgt - 8);
  }

  // gradient line
  const grad = ctx.createLinearGradient(pad.l, 0, w - pad.r, 0);
  grad.addColorStop(0, '#ff6ec4');
  grad.addColorStop(0.4, '#8b7bff');
  grad.addColorStop(0.75, '#4adede');
  grad.addColorStop(1, '#ffe66d');

  // area fill
  if (pts.length > 1) {
    const fill = ctx.createLinearGradient(0, pad.t, 0, hgt - pad.b);
    fill.addColorStop(0, 'rgba(139,123,255,.25)');
    fill.addColorStop(1, 'rgba(139,123,255,0)');
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.price)) : ctx.moveTo(X(i), Y(p.price)));
    ctx.lineTo(X(pts.length - 1), hgt - pad.b);
    ctx.lineTo(X(0), hgt - pad.b);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.price)) : ctx.moveTo(X(i), Y(p.price)));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // points
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(X(i), Y(p.price), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = p.source === 'tcg' ? '#4adede' : '#ffe66d';
    ctx.fill();
    ctx.strokeStyle = '#0a0c16';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}

/* ---------------- TCG API ---------------- */

// api.pokemontcg.io is flaky: requests sometimes hang for minutes or get
// rate-limited. Every call goes through this helper — hard timeout, retries
// with backoff, and an optional API key for better rate limits.
async function tcgFetch(path, { retries = 3, timeoutMs = 18000, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = {};
      const key = localStorage.getItem(KEYS.apiKey);
      if (key) headers['X-Api-Key'] = key;
      const res = await fetch(`${TCG_API}${path}`, { headers, signal: ctrl.signal });
      if (res.status === 429) throw new Error('rate limited — add a free API key via ⚙ or wait a minute');
      if (res.status >= 500) throw new Error(`TCG API server error ${res.status}`);
      if (!res.ok) throw new Error(`TCG API error ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('TCG API timed out') : err;
      if (attempt < retries) {
        onRetry?.(attempt + 1, retries);
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function tcgMarketPrice(tcgCard) {
  const prices = tcgCard?.tcgplayer?.prices;
  if (!prices) return null;
  const variants = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil', '1stEditionNormal', 'unlimitedHolofoil'];
  for (const v of variants) {
    const p = prices[v];
    if (p && (p.market || p.mid)) return p.market || p.mid;
  }
  const first = Object.values(prices)[0];
  return first ? (first.market || first.mid || null) : null;
}

async function tcgSearch(query, onRetry) {
  const data = await tcgFetch(
    `/cards?q=name:"${encodeURIComponent(query)}"&pageSize=14&orderBy=-set.releaseDate` +
    `&select=id,name,number,rarity,set,images,tcgplayer`,
    { onRetry });
  return data.data || [];
}

function openTcgModal() {
  const card = selectedCard();
  if (!card) return;
  $('#tcg-overlay').classList.remove('hidden');
  $('#tcg-query').value = card.name;
  $('#tcg-results').innerHTML = '<div class="tcg-status">Search for a card to link.</div>';
  $('#tcg-query').focus();
}

async function runTcgSearch(e) {
  e.preventDefault();
  const q = $('#tcg-query').value.trim();
  if (!q) return;
  const results = $('#tcg-results');
  results.innerHTML = '<div class="tcg-status">Searching the TCG database…</div>';
  try {
    const cards = await tcgSearch(q, (attempt, max) => {
      results.innerHTML = `<div class="tcg-status">TCG API is slow right now — retrying (${attempt}/${max})…</div>`;
    });
    if (!cards.length) {
      results.innerHTML = '<div class="tcg-status">No cards found. Try a different name.</div>';
      return;
    }
    results.innerHTML = '';
    for (const tc of cards) {
      const usd = tcgMarketPrice(tc);
      const price = usd != null ? usdToAud(usd) : null;
      const row = document.createElement('div');
      row.className = 'tcg-result';
      row.innerHTML = `
        ${tc.images?.small ? `<img src="${tc.images.small}" alt="">` : ''}
        <div class="t-meta">
          <div class="t-name">${esc(tc.name)}</div>
          <div class="t-set">${esc(tc.set?.name || '')} · #${esc(tc.number || '?')} · ${esc(tc.rarity || 'Unknown rarity')}</div>
        </div>
        <div class="t-price">${price != null ? fmt$(price) : 'no price'}</div>`;
      row.addEventListener('click', () => linkTcgCard(tc, price));
      results.appendChild(row);
    }
  } catch (err) {
    results.innerHTML = `<div class="tcg-status">Search failed: ${esc(err.message)}.<br>
      The TCG API has flaky days — try again shortly, or add a free API key from pokemontcg.io via the ⚙ button for priority access.</div>`;
  }
}

function linkTcgCard(tc, price) {
  const card = selectedCard();
  if (!card) return;
  card.tcgId = tc.id;
  card.tcgName = `${tc.name} · ${tc.set?.name || ''}`;
  card.tcgImage = tc.images?.small || null;
  if (!card.set && tc.set?.name) card.set = tc.set.name;
  if (!card.number && tc.number) card.number = tc.number;
  if (price != null) {
    card.priceHistory.push({ date: todayISO(), price, source: 'tcg' });
  }
  saveCollection();
  $('#tcg-overlay').classList.add('hidden');
  renderMarket();
  renderCollection();
  toast(`Linked to ${tc.name} (${tc.set?.name || 'TCG'})${price != null ? ' — price logged!' : ''}`);
}

async function refreshPrice() {
  const card = selectedCard();
  if (!card) return;
  if (!card.tcgId) {
    toast('Link a TCG card first to fetch live prices.');
    openTcgModal();
    return;
  }
  const btn = $('#btn-refresh-price');
  btn.disabled = true;
  btn.textContent = '↻ Fetching…';
  try {
    const { data } = await tcgFetch(`/cards/${card.tcgId}?select=id,name,tcgplayer`, {
      onRetry: (attempt, max) => { btn.textContent = `↻ Retrying (${attempt}/${max})…`; },
    });
    const usd = tcgMarketPrice(data);
    if (usd == null) throw new Error('no market price on this printing');
    const price = usdToAud(usd);
    // replace today's tcg entry if one exists, else append
    const today = todayISO();
    const existing = card.priceHistory.find(p => p.date === today && p.source === 'tcg');
    if (existing) existing.price = price;
    else card.priceHistory.push({ date: today, price, source: 'tcg' });
    card.priceHistory.sort((a, b) => a.date.localeCompare(b.date));
    saveCollection();
    renderMarket();
    renderCollection();
    toast(`Market price: ${fmt$(price)}`);
  } catch (err) {
    toast(`Fetch failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Fetch market price';
  }
}

/* ============================================================
   HEADER / NAV / WIRING
   ============================================================ */

function updateHeaderStats() {
  $('#stat-caught').textContent = `${state.caught.size} / ${TOTAL_POKEMON}`;
  $('#stat-bar-fill').style.width = `${(state.caught.size / TOTAL_POKEMON) * 100}%`;
  const total = state.collection.reduce((sum, c) => sum + (currentPrice(c) ?? 0), 0);
  $('#stat-value').textContent = fmt$(total);
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('active', v.id === `view-${view}`));
  if (view !== 'dex') closeDrawer();
  if (view === 'collection') renderCollection();
  if (view === 'market') renderMarket();
}

function wireEvents() {
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.addEventListener('click', () => switchView(t.dataset.view)));

  $('#dex-search').addEventListener('input', applyDexFilter);
  $('#dex-caught-only').addEventListener('change', applyDexFilter);
  $('#drawer-close').addEventListener('click', closeDrawer);

  $('#btn-add-card').addEventListener('click', () => openCardForm(null));
  wireSetAutocomplete();
  $('#card-form').addEventListener('submit', submitCardForm);
  $('#cf-cancel').addEventListener('click', closeCardForm);
  $('#card-form-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCardForm();
  });

  $('#market-card-select').addEventListener('change', (e) => {
    state.selectedCardId = e.target.value;
    renderMarket();
  });
  $('#manual-price-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const card = selectedCard();
    if (!card) return;
    const price = Number($('#price-value').value);
    const date = $('#price-date').value || todayISO();
    if (!(price >= 0)) return;
    card.priceHistory.push({ date, price, source: 'manual' });
    card.priceHistory.sort((a, b) => a.date.localeCompare(b.date));
    saveCollection();
    $('#price-value').value = '';
    renderMarket();
    renderCollection();
    toast(`Logged ${fmt$(price)} for ${card.name}.`);
  });
  $('#btn-link-tcg').addEventListener('click', openTcgModal);
  $('#btn-refresh-price').addEventListener('click', refreshPrice);
  $('#btn-api-key').addEventListener('click', () => {
    const current = localStorage.getItem(KEYS.apiKey) || '';
    const key = prompt(
      'Optional: paste a free pokemontcg.io API key for faster, more reliable market data.\n' +
      'Get one at https://dev.pokemontcg.io — leave empty to remove.',
      current);
    if (key === null) return; // cancelled
    if (key.trim()) {
      localStorage.setItem(KEYS.apiKey, key.trim());
      toast('API key saved — market requests now use it.');
    } else {
      localStorage.removeItem(KEYS.apiKey);
      toast('API key removed.');
    }
  });
  $('#tcg-search-form').addEventListener('submit', runTcgSearch);
  $('#tcg-cancel').addEventListener('click', () => $('#tcg-overlay').classList.add('hidden'));
  $('#tcg-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // account / sync
  $('#btn-signin').addEventListener('click', () => {
    $('#signin-status').textContent = '';
    $('#signin-status').className = 'signin-status';
    $('#signin-overlay').classList.remove('hidden');
    $('#signin-email').focus();
  });
  $('#signin-cancel').addEventListener('click', () => $('#signin-overlay').classList.add('hidden'));
  $('#signin-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  $('#btn-signout').addEventListener('click', () => supa?.auth.signOut());

  // sign-in: password log in / sign up, with magic link as a fallback
  const setStatus = (msg, kind) => {
    const s = $('#signin-status');
    s.className = 'signin-status' + (kind ? ' ' + kind : '');
    s.textContent = msg;
  };
  const authEmail = () => $('#signin-email').value.trim();
  const authPass = () => $('#signin-password').value;
  const busy = (on, btn, label) => { btn.disabled = on; if (on) btn.dataset.label = btn.textContent; btn.textContent = on ? label : btn.dataset.label; };

  $('#signin-form').addEventListener('submit', async (e) => {
    e.preventDefault(); // "Log in" = password sign-in
    if (!authEmail()) return;
    if (authPass().length < 6) { setStatus('Enter a password (min 6 characters), or use the magic link below.', 'err'); return; }
    const btn = $('#btn-login');
    busy(true, btn, 'Logging in…'); setStatus('');
    try {
      await passwordSignIn(authEmail(), authPass());
      setStatus('✓ Logged in!', 'ok'); // modal closes via onAuthStateChange
    } catch (err) {
      const m = (err.message || '').toLowerCase();
      setStatus(m.includes('invalid')
        ? 'Wrong email or password — or hit "Create account" if you\'re new.'
        : 'Login failed: ' + (err.message || err), 'err');
    } finally { busy(false, btn); }
  });

  $('#btn-signup').addEventListener('click', async () => {
    if (!authEmail()) { setStatus('Enter your email first.', 'err'); return; }
    if (authPass().length < 6) { setStatus('Pick a password with at least 6 characters.', 'err'); return; }
    const btn = $('#btn-signup');
    busy(true, btn, 'Creating…'); setStatus('');
    try {
      const data = await passwordSignUp(authEmail(), authPass());
      if (data.session) setStatus('✓ Account created — you\'re in!', 'ok'); // onAuthStateChange syncs + closes
      else setStatus('Account created! Check your email to confirm, then log in. (Or disable email confirmation in Supabase to skip this.)', 'ok');
    } catch (err) {
      const m = (err.message || '').toLowerCase();
      setStatus(m.includes('already')
        ? 'That email already has an account — just log in.'
        : 'Could not create account: ' + (err.message || err), 'err');
    } finally { busy(false, btn); }
  });

  $('#btn-magic').addEventListener('click', async () => {
    if (!authEmail()) { setStatus('Enter your email first.', 'err'); return; }
    const btn = $('#btn-magic');
    busy(true, btn, 'Sending…'); setStatus('');
    try {
      await sendMagicLink(authEmail());
      setStatus('✓ Magic link sent — check your inbox!', 'ok');
    } catch (err) {
      const m = (err.message || '').toLowerCase();
      setStatus(m.includes('rate') || m.includes('limit')
        ? 'Email limit hit — wait a bit, or just use a password above.'
        : 'Could not send link: ' + (err.message || err), 'err');
    } finally { busy(false, btn); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      closeCardForm();
      $('#tcg-overlay').classList.add('hidden');
      $('#signin-overlay').classList.add('hidden');
    }
  });

  window.addEventListener('resize', () => {
    if (state.view === 'market') {
      const card = selectedCard();
      if (card) drawChart(card);
    }
  });
}

/* ---------------- boot ---------------- */

function init() {
  load();
  initSupabase();
  $('#price-date').value = todayISO();
  buildDexGrid();
  wireEvents();
  updateHeaderStats();
  wireAuth();      // restores session + syncs if already signed in
  loadNames();
  loadFx();
}

init();
