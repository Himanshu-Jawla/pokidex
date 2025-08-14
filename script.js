

// API root
const API = "https://pokeapi.co/api/v2";

// ---------- App State (single source of truth) ----------
const state = {
  page: 1,
  pageSize: 24,
  total: 0,
  // active filters
  query: "",
  type: "",
  gen: "",
  // cache maps to avoid repeat fetches
  cachePokemon: new Map(), // id/name -> full data
  // favorites (ids)
  favorites: new Set(JSON.parse(localStorage.getItem("pokedex:favs") || "[]")),
};

// ---------- Elements ----------
const els = {
  grid: document.getElementById("grid"),
  status: document.getElementById("status"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  pageInfo: document.getElementById("pageInfo"),
  searchInput: document.getElementById("searchInput"),
  searchBtn: document.getElementById("searchBtn"),
  typeFilter: document.getElementById("typeFilter"),
  genFilter: document.getElementById("genFilter"),
  favList: document.getElementById("favList"),
  clearFavs: document.getElementById("clearFavs"),
  darkToggle: document.getElementById("darkToggle"),
  detailModal: document.getElementById("detailModal"),
  modalContent: document.getElementById("modalContent"),
};

// ---------- Boot ----------
init();

async function init() {
  // Dark mode from preference
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const savedDark = localStorage.getItem("pokedex:dark");
  setDarkMode(savedDark !== null ? savedDark === "1" : prefersDark);

  // Wire up UI events
  wireEvents();

  // Populate type filter
  await populateTypeOptions();

  // Initial render
  update();
}

// ---------- Events ----------
function wireEvents() {
  // Search
  els.searchBtn.addEventListener("click", () => {
    state.query = els.searchInput.value.trim().toLowerCase();
    state.page = 1;
    update();
  });
  els.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.searchBtn.click();
  });

  // Filters
  els.typeFilter.addEventListener("change", () => {
    state.type = els.typeFilter.value;
    state.page = 1;
    update();
  });
  els.genFilter.addEventListener("change", () => {
    state.gen = els.genFilter.value;
    state.page = 1;
    update();
  });

  // Pagination
  els.prevBtn.addEventListener("click", () => {
    if (state.page > 1) {
      state.page--;
      update();
    }
  });
  els.nextBtn.addEventListener("click", () => {
    const maxPage = Math.ceil(state.total / state.pageSize);
    if (state.page < maxPage) {
      state.page++;
      update();
    }
  });

  // Favorites
  els.clearFavs.addEventListener("click", () => {
    state.favorites.clear();
    persistFavs();
    renderFavorites();
    // also refresh card stars
    updateCardsFavState();
  });

  // Dark mode
  els.darkToggle.addEventListener("change", () => {
    setDarkMode(els.darkToggle.checked);
  });

  // Modal ESC close (for browsers that support <dialog>)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.detailModal.open) els.detailModal.close();
  });
}

// ---------- Dark mode ----------
function setDarkMode(on) {
  document.documentElement.classList.toggle("dark", on);
  els.darkToggle.checked = on;
  localStorage.setItem("pokedex:dark", on ? "1" : "0");
}

// ---------- Data fetching helpers ----------
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Get a full Pokémon object by id or name.
 * Caches results (Map) to avoid repeat network calls.
 */
async function getPokemon(idOrName) {
  const key = String(idOrName).toLowerCase();
  if (state.cachePokemon.has(key)) return state.cachePokemon.get(key);
  const data = await fetchJSON(`${API}/pokemon/${key}`);
  state.cachePokemon.set(key, data);
  // also index by numeric id for quick hits
  state.cachePokemon.set(String(data.id), data);
  state.cachePokemon.set(data.name.toLowerCase(), data);
  return data;
}

/**
 * Calculate ID range for a selected generation.
 * Returns [startId, endId], both inclusive. Empty string => full range.
 */
function genRange(gen) {
  const map = {
    "1": [1, 151],   "2": [152, 251], "3": [252, 386],
    "4": [387, 493], "5": [494, 649], "6": [650, 721],
    "7": [722, 809], "8": [810, 898], "9": [899, 1017],
  };
  return map[gen] || [1, 1017];
}

/**
 * Get a filtered list of Pokémon IDs that match current filters.
 * Strategy:
 * - If type filter is set, start from that type's list (server-side filter).
 * - Apply generation range and free-text query on the client.
 */
async function getFilteredIds() {
  let baseIds = [];

  if (state.type) {
    // Server-side type filter (fast)
    const typeData = await fetchJSON(`${API}/type/${state.type}`);
    baseIds = typeData.pokemon
      .map((p) => extractId(p.pokemon.url))
      .filter((id) => id <= 1017); // ignore forms beyond main index
  } else {
    // All IDs up to latest national dex entry (tweakable)
    baseIds = Array.from({ length: 1017 }, (_, i) => i + 1);
  }

  // Generation filter
  if (state.gen) {
    const [start, end] = genRange(state.gen);
    baseIds = baseIds.filter((id) => id >= start && id <= end);
  }

  // Search filter (name or id)
  if (state.query) {
    const q = state.query;
    baseIds = await filterByQuery(baseIds, q);
  }

  // Stable sort
  baseIds.sort((a, b) => a - b);
  return baseIds;
}

/**
 * Filter by query: if numeric, match ID; else match name contains.
 * To match names, we need name data. We fetch minimal pages lazily.
 */
async function filterByQuery(ids, q) {
  // numeric query: match id directly
  if (/^\d+$/.test(q)) {
    const id = Number(q);
    return ids.includes(id) ? [id] : [];
  }

  // text query: fetch names for the candidate ids (lazy + cached by getPokemon)
  const results = [];
  const lower = q.toLowerCase();

  // To avoid hammering the API, peek names via /pokemon-species/ID (lighter)
  // but species also costs a call. We'll optimistically fetch actual pokemon for matches we need.
  for (const id of ids) {
    try {
      const p = await getPokemon(id);
      if (p.name.includes(lower)) results.push(id);
      // Heuristic: stop early if results are already large (keeps UI snappy)
      if (results.length >= 200) break;
    } catch { /* ignore missing */ }
  }
  return results;
}

function extractId(url) {
  // URLs look like .../pokemon/25/
  const parts = url.split("/").filter(Boolean);
  return Number(parts[parts.length - 1]);
}

// ---------- Render pipeline ----------
async function update() {
  try {
    setStatus("Loading…");
    toggleControls(true);

    const allIds = await getFilteredIds();
    state.total = allIds.length;

    const start = (state.page - 1) * state.pageSize;
    const pageIds = allIds.slice(start, start + state.pageSize);

    // Fetch details for what's on screen in parallel
    const data = await Promise.all(pageIds.map((id) => getPokemon(id)));

    renderGrid(data);
    renderPagination();
    renderFavorites();
    setStatus(state.total ? `${state.total} result(s)` : "No results.");
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong. Check your connection and try again.");
    els.grid.innerHTML = "";
  } finally {
    toggleControls(false);
  }
}

function setStatus(msg) { els.status.textContent = msg; }

function toggleControls(loading) {
  for (const el of [els.searchBtn, els.prevBtn, els.nextBtn, els.typeFilter, els.genFilter]) {
    el.disabled = loading;
  }
}

function renderPagination() {
  const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
  els.pageInfo.textContent = `Page ${state.page} / ${maxPage}`;
  els.prevBtn.disabled = state.page <= 1;
  els.nextBtn.disabled = state.page >= maxPage;
}

function renderGrid(list) {
  els.grid.innerHTML = list.map(cardHTML).join("");
  // Wire card buttons after inject
  els.grid.querySelectorAll("[data-action='detail']").forEach((btn) => {
    btn.addEventListener("click", () => openDetail(btn.dataset.id));
  });
  els.grid.querySelectorAll("[data-action='fav']").forEach((btn) => {
    btn.addEventListener("click", () => toggleFav(Number(btn.dataset.id), btn));
  });
}

function updateCardsFavState() {
  els.grid.querySelectorAll("[data-action='fav']").forEach((btn) => {
    const id = Number(btn.dataset.id);
    btn.setAttribute("aria-pressed", String(state.favorites.has(id)));
    btn.title = state.favorites.has(id) ? "Remove from favorites" : "Add to favorites";
    btn.textContent = state.favorites.has(id) ? "★" : "☆";
  });
}

function typeChip(t) {
  return `<span class="type ${t}">${t}</span>`;
}

function cardHTML(p) {
  const id = p.id.toString().padStart(3, "0");
  const types = p.types.map((t) => t.type.name);
  // Try official artwork first; fall back to front_default
  const img =
    p.sprites.other?.["official-artwork"]?.front_default ||
    p.sprites.front_default ||
    "";

  const fav = state.favorites.has(p.id);

  return `
    <article class="card" aria-label="${p.name}">
      <div class="card-header">
        <strong class="card-id">#${id}</strong>
        <button class="btn" data-action="fav" data-id="${p.id}" aria-pressed="${fav}" title="${fav ? "Remove from favorites" : "Add to favorites"}">
          ${fav ? "★" : "☆"}
        </button>
      </div>
      <div class="thumb">${img ? `<img alt="${p.name}" src="${img}">` : ""}</div>
      <h3 class="card-name">${p.name}</h3>
      <div class="type-row">${types.map(typeChip).join("")}</div>
      <button class="btn" data-action="detail" data-id="${p.id}" aria-label="View ${p.name} details">Details</button>
    </article>
  `;
}

// ---------- Favorites ----------
function toggleFav(id, btn) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  persistFavs();
  renderFavorites();
  if (btn) updateCardsFavState();
}

function persistFavs() {
  localStorage.setItem("pokedex:favs", JSON.stringify([...state.favorites]));
}

async function renderFavorites() {
  const items = await Promise.all([...state.favorites].slice(0, 20).map((id) => getPokemon(id)));
  els.favList.innerHTML = items
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const sprite = p.sprites.front_default || p.sprites.other?.["official-artwork"]?.front_default || "";
      return `<li>
        <img src="${sprite}" alt="${p.name}">
        <span class="name">#${String(p.id).padStart(3,"0")} ${p.name}</span>
        <button class="btn ghost" aria-label="Remove ${p.name} from favorites" data-remove="${p.id}">Remove</button>
      </li>`;
    })
    .join("");

  // Wire remove buttons
  els.favList.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => toggleFav(Number(btn.dataset.remove)));
  });
}

// ---------- Types filter options ----------
async function populateTypeOptions() {
  const data = await fetchJSON(`${API}/type`);
  const types = data.results
    .map((t) => t.name)
    .filter((n) => !["shadow", "unknown"].includes(n))
    .sort();

  els.typeFilter.innerHTML =
    `<option value="">All types</option>` +
    types.map((t) => `<option value="${t}">${capitalize(t)}</option>`).join("");
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- Modal (details) ----------
async function openDetail(id) {
  try {
    const p = await getPokemon(id);
    const species = await fetchJSON(`${API}/pokemon-species/${p.id}`);
    const flavor =
      species.flavor_text_entries.find((e) => e.language.name === "en")?.flavor_text
        ?.replace(/\f/g, " ")
        ?.replace(/\n/g, " ") || "No description.";

    const img =
      p.sprites.other?.["official-artwork"]?.front_default ||
      p.sprites.front_default ||
      "";

    const types = p.types.map((t) => t.type.name);

    const stats = {};
    p.stats.forEach((s) => { stats[s.stat.name] = s.base_stat; });

    els.modalContent.innerHTML = `
      <div class="modal-hero">
        <div class="art">${img ? `<img alt="${p.name}" src="${img}">` : ""}</div>
        <div>
          <h2 style="margin:0 0 .25rem 0; text-transform:capitalize;">#${String(p.id).padStart(3,"0")} ${p.name}</h2>
          <p style="margin:.25rem 0; color:var(--muted);">${flavor}</p>
          <div class="type-row" style="margin-top:.5rem;">${types.map(typeChip).join("")}</div>
          <div class="kv" style="margin-top:.75rem;">
            <div><small class="muted">Height</small><strong>${p.height/10} m</strong></div>
            <div><small class="muted">Weight</small><strong>${p.weight/10} kg</strong></div>
            <div><small class="muted">Base XP</small><strong>${p.base_experience ?? "—"}</strong></div>
            <div><small class="muted">Abilities</small><strong>${p.abilities.map(a => a.ability.name).join(", ")}</strong></div>
          </div>
        </div>
      </div>

      <div>
        <h3 style="margin:.5rem 0;">Base Stats</h3>
        ${statRow("HP", stats["hp"])}
        ${statRow("Attack", stats["attack"])}
        ${statRow("Defense", stats["defense"])}
        ${statRow("Sp. Atk", stats["special-attack"])}
        ${statRow("Sp. Def", stats["special-defense"])}
        ${statRow("Speed", stats["speed"])}
      </div>
    `;

    openModal();
  } catch (err) {
    console.error(err);
    alert("Failed to load details. Try again.");
  }
}

function statRow(label, value) {
  const max = 255; // rough max for bar scale
  const pct = Math.min(100, Math.round((value / max) * 100));
  return `
    <div style="display:grid; grid-template-columns: 110px 1fr; align-items:center; gap:.5rem; margin:.35rem 0;">
      <span>${label}</span>
      <div class="statbar" aria-label="${label} ${value}"><span style="width:${pct}%"></span></div>
      <span style="justify-self:end; font-variant-numeric:tabular-nums;">${value}</span>
    </div>
  `;
}

function openModal() {
  if (typeof els.detailModal.showModal === "function") {
    els.detailModal.showModal();
  } else {
    // Fallback for browsers without <dialog>
    els.detailModal.setAttribute("open", "");
  }
  // Close actions
  els.detailModal.querySelector(".modal-close").onclick = () => els.detailModal.close();
  els.detailModal.addEventListener("click", (e) => {
    const rect = els.detailModal.querySelector(".modal-card").getBoundingClientRect();
    const inDialog = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inDialog) els.detailModal.close();
  }, { once: true });
}

// ---------- Utilities ----------
function updateCardsAfterFilter() {
  // Not used now, placeholder if you add more live filters
}

// Initial type of page is 1; ensure initial filters applied
// Nothing else to do here; update() handles first render.
