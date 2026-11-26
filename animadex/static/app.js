/* ===== ANIMADEX frontend ============================================ */
'use strict';

const MODES = {
  characters: {
    noun: 'character',
    facets: ['character', 'copyright', 'hair_color', 'hair_length',
             'eye_color', 'gender'],
    placeholder: n => `Search ${n} characters — names, series, tags…`,
    countLabel: 'Image Count',
  },
  artists: {
    noun: 'artist',
    facets: ['artist', 'score', 'category'],
    placeholder: n => `Search ${n} artists by name…`,
    countLabel: 'Image Count',
  },
  copyrights: {
    noun: 'copyright',
    facets: [],                         // browse view -- no filter sidebar
    placeholder: n => `Search ${n} copyrights by name…`,
    countLabel: 'Character Count',
  },
  favourites: {
    noun: 'favourite',
    facets: [],                         // your own list -- nothing to filter
    placeholder: n => `Search your ${n} favourites…`,
    countLabel: 'Image Count',
  },
};
const DEFAULT_OPEN = new Set();   // every facet group starts collapsed
const DEV = window.ANIMADEX_DEV === true;   // run: python app.py --dev
const FACET_LABELS = {
  character:'Character', copyright:'Series', hair_color:'Hair',
  hair_length:'Length', eye_color:'Eyes', gender:'Gender', artist:'Artist',
  score:'Score', category:'Classifications',
};

function freshFilters(mode){
  return Object.fromEntries(MODES[mode].facets.map(f => [f, new Set()]));
}

const state = {
  mode: 'characters',
  q: '',
  sort: 'count',
  seed: null,                 // random-sort shuffle key
  filters: freshFilters('characters'),
  labels: {},                 // value -> human label (for active chips)
  page: 1,
  total: 0,
  pages: 1,
  activeCat: '',              // dev mode: the category being tagged
  catMembers: new Set(),      // dev mode: artist slugs in activeCat
  regenMode: false,           // dev mode: character regenerate toggle
  regenning: new Set(),       // dev mode: slugs regenerating in background
  lorasOnly: false,           // characters: only those with a CivitAI LoRA
  // favourites: which datasets to show. Both by default; empty means the
  // user unticked both, which really does mean "show nothing".
  favKinds: new Set(['characters', 'artists']),
};

const $ = s => document.querySelector(s);
const gallery    = $('#gallery');
const statusEl   = $('#status');
const pagerEl    = $('#pager');
const facetsEl   = $('#facets');
const chipsEl    = $('#chips');
const resultEl   = $('#resultcount');
const clearBtn   = $('#clearall');
const browseMenu = $('#browsemenu');

const facetOf = () => MODES[state.mode].facets;
const apiURL  = path => '/api/' + state.mode + path;

/* ---- helpers -------------------------------------------------------- */
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmt(n){
  if (n >= 1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'') + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'') + 'K';
  return '' + n;
}
function debounce(fn, ms){
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function hueOf(s){
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/* ---- clipboard + toast --------------------------------------------- */
let toastTimer;
function toast(msg){
  const el = $('#toast');
  el.innerHTML = `<b>✦</b> ${esc(msg)}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1700);
}
/* Stable Diffusion / ComfyUI prompts treat unescaped parens as weight
   modifiers (e.g. `(red eyes)` = 1.1x emphasis), so a character like
   `ram (re:zero)` would silently boost "re:zero" instead of staying
   literal. Backslash-escape both `(` and `)` so the copied prompt
   pastes 1:1 into a generator. */
function escParens(s){
  return String(s).replace(/[()]/g, '\\$&');
}

async function copyText(text, note){
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(note);
}

/* ===== favourites =================================================== */
/* Hearted entries live in SQLite (so they outlive the browser), but the
   whole list is mirrored in memory on page load. Tiles are stamped from
   that copy, which keeps /api/<mode>/search -- a cacheable, shared
   response -- free of anything personal. */
const favs = { characters: new Set(), artists: new Set() };
let favTotal = 0;

/* On the favourites page a tile can be either dataset, so the payload
   carries `kind`; everywhere else the current mode IS the kind. */
const favKindOf = c => (c.kind === 'artists' ? 'artists' : 'characters');
const tileKind = c => (state.mode === 'favourites' ? favKindOf(c) : state.mode);

const HEART_PATH =
  'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 ' +
  '7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z';

/* Hearted = a solid heart; unhearted = the same outline. Same path, so
   the icon never shifts position. */
/* The type filter, mirrored onto the two checkboxes in the toolbar. */
function syncFavKindBoxes(){
  document.querySelectorAll('[data-favkind]').forEach(cb => {
    cb.checked = state.favKinds.has(cb.dataset.favkind);
    const opt = cb.closest('.fopt');
    if (opt) opt.classList.toggle('on', cb.checked);
  });
}

function renderFavCounts(){
  for (const kind of ['characters', 'artists']){
    const el = document.querySelector(
      `[data-favkind-count="${kind}"]`);
    if (el) el.textContent = favs[kind] ? favs[kind].size : 0;
  }
}

/* Both ticked is the default, so it writes nothing to the address bar.
   One ticked writes that one. Neither writes an empty `kind`, which the
   server reads as "nothing" rather than "no filter". */
function appendFavKinds(p){
  if (state.mode !== 'favourites') return p;
  const k = state.favKinds;
  if (k.size === 2) return p;
  if (k.size === 0){ p.append('kind', ''); return p; }
  for (const v of k) p.append('kind', v);
  return p;
}

function favBtnHTML(on){
  return `<button class="tile-fav-btn${on ? ' on' : ''}" data-w="fav"
    type="button" aria-pressed="${on ? 'true' : 'false'}"
    aria-label="${on ? 'Remove from favourites' : 'Add to favourites'}">
    <svg viewBox="0 0 24 24" ${on
      ? 'fill="currentColor"'
      : 'fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round"'}>
      <path d="${HEART_PATH}"></path></svg></button>`;
}

async function loadFavourites(){
  try {
    const d = await (await fetch('/api/favourites')).json();
    favs.characters = new Set(d.characters || []);
    favs.artists    = new Set(d.artists || []);
    favTotal = d.total || 0;
  } catch {
    /* No list is better than no gallery -- the hearts just start off. */
  }
  syncFavBtn();
}

function syncFavBtn(){
  const count = $('#fav-count');
  count.textContent = favTotal;
  count.hidden = favTotal === 0;
  const btn = $('#fav-btn');
  const on = state.mode === 'favourites';
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-current', on ? 'page' : 'false');
  renderFavCounts();
  syncFavKindBoxes();
}

/* Repaint one tile's heart without re-rendering the gallery. */
function paintFavTile(tile, on){
  const btn = tile.querySelector('.tile-fav-btn');
  if (btn) btn.outerHTML = favBtnHTML(on);
}

function dropFavTile(tile){
  tile.remove();
  state.total = Math.max(0, (state.total || 1) - 1);
  renderResultCount();
  if (!gallery.querySelector('.tile')) renderEmptyState();
}

async function toggleFavourite(tile){
  const kind = tile.dataset.kind || 'characters';
  const slug = tile.dataset.slug;
  if (!favs[kind]){                 // tiles that can't be hearted
    toast('Favourites are only available for characters and artists');
    return;
  }
  const want = !favs[kind].has(slug);

  // optimistic: the heart flips immediately and rolls back on failure
  favs[kind].add(slug);
  if (!want) favs[kind].delete(slug);
  favTotal = Math.max(0, favTotal + (want ? 1 : -1));
  paintFavTile(tile, want);
  syncFavBtn();

  try {
    const res = await fetch('/api/favourites/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, slug }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok)
      throw new Error(data.error || ('HTTP ' + res.status));
    if (typeof data.total === 'number') favTotal = data.total;
    syncFavBtn();
    if (state.mode === 'favourites' && !data.favourited) dropFavTile(tile);
    toast(data.favourited ? '♥ Added to favourites'
                          : 'Removed from favourites');
  } catch (err){
    if (want) favs[kind].delete(slug); else favs[kind].add(slug);
    favTotal = Math.max(0, favTotal + (want ? -1 : 1));
    paintFavTile(tile, !want);
    syncFavBtn();
    toast('Could not update favourites — ' + err.message);
  }
}

/* ===== tiles ======================================================== */
function tileHTML(c){
  const mode = state.mode;
  const kind = tileKind(c);         // what this tile should look like
  const slug = encodeURIComponent(c.slug);
  const initial = (c.name || '?').trim().charAt(0).toUpperCase() || '?';

  // Copyright browse tile: collage, name, character count, no overlay.
  if (mode === 'copyrights'){
    return `<article class="tile tile-copyright" data-slug="${esc(c.slug)}"
              data-name="${esc(c.name)}">
      <div class="thumb">
        <div class="ph" style="--h:${hueOf(c.name || c.slug)}">
          <span>${esc(initial)}</span></div>
        <img class="shot" loading="lazy" decoding="async"
             src="${esc(c.thumb_url || '')}" alt="${esc(c.name)}"
             onerror="this.remove()">
      </div>
      <div class="meta">
        <div class="name" title="${esc(c.name)}">${esc(c.name)}</div>
        <div class="subtag">${c.count.toLocaleString()} character${
          c.count === 1 ? '' : 's'}</div>
      </div>
    </article>`;
  }

  const ph = `<div class="ph" style="--h:${hueOf(c.name || c.slug)}">
      <span>${esc(initial)}</span><em>awaiting render</em></div>`;
  const shot = c.has_image
    ? `<img class="shot" loading="lazy" decoding="async"
            src="${esc(c.thumb_url || '')}" alt="${esc(c.name)}"
            onerror="this.remove()">` : '';

  const buttons = [];
  if (c.has_image)
    buttons.push(`<button class="actbtn previewbtn">
      <span class="ic">⛶</span> Full image</button>`);
  if (c.url)
    buttons.push(`<a class="actbtn" href="${esc(c.url)}" target="_blank"
      rel="noopener"><span class="ic">↗</span> Danbooru</a>`);
  const top = buttons.length ? `<div class="ov-top">${buttons.join('')}</div>`
                             : '';

  let overlay, meta;
  if (kind === 'artists'){
    overlay = `
      <div class="ov-scroll">
        <div class="ov-label">Artist tag</div>
        <div class="ov-trigger">@${esc(c.trigger)}</div>
      </div>
      <div class="ov-actions">
        ${top}
        <button class="copybtn" data-copy="trigger">
          <span class="ic">⧉</span> Copy @artist</button>
      </div>`;
    const scoreBadge = c.score != null
      ? `<span class="scorebadge"><i>SCORE</i> ` +
        `${Math.round(c.score * 100)}%</span>`
      : '';
    meta = `<div class="name" title="${esc(c.name)}">${esc(c.name)}</div>
      ${scoreBadge}`;
  } else {
    const tags = c.tags.map(t => `<span class="tag">${esc(t)}</span>`)
                       .join('');
    overlay = `
      <div class="ov-scroll">
        <div class="ov-label">Trigger</div>
        <div class="ov-trigger">${esc(c.trigger)}</div>
        <div class="ov-label">Tags · ${c.tags.length}</div>
        <div class="ov-tags">${tags}</div>
      </div>
      <div class="ov-actions">
        ${top}
        <div class="ov-copy">
          <button class="copybtn" data-copy="trigger">
            <span class="ic">⧉</span> Trigger</button>
          <button class="copybtn" data-copy="all">
            <span class="ic">⧉</span> Trigger + tags</button>
        </div>
      </div>`;
    // a real link to the series-filtered view: middle / Ctrl+click opens
    // it in a new tab natively; a plain left-click is handled in-app.
    const cpHref = '/?' + new URLSearchParams(
      { copyright: c.copyright }).toString();
    meta = `<div class="name" title="${esc(c.name)}">${esc(c.name)}</div>
      <a class="copyright" href="${esc(cpHref)}"
         data-copyright="${esc(c.copyright)}"
         title="${esc(c.copyright_name)}">${esc(c.copyright_name)}</a>`;
  }

  const loraCap = (kind === 'characters' && c.loras && c.loras.length)
    ? '<span class="lora-cap">+ LORA</span>' : '';
  // On the favourites page characters and artists share a grid, so each
  // tile says which it is.
  const kindBadge = mode === 'favourites'
    ? `<div class="badge badge-kind">${kind === 'artists'
        ? 'Artist' : 'Character'}</div>`
    : '';
  return `<article class="tile" data-slug="${esc(c.slug)}"
                   data-kind="${esc(kind)}"
                   data-img-url="${esc(c.img_url || '')}">
    <div class="thumb">
      ${ph}${shot}
      <div class="tbadges">
        ${loraCap}${kindBadge}<div class="badge"><i>▲</i> ${fmt(c.count)}</div>
      </div>
      <div class="overlay">${overlay}</div>
      ${favBtnHTML(favs[kind] && favs[kind].has(c.slug))}
    </div>
    <div class="meta">${meta}</div>
  </article>`;
}

function skeletons(n){
  let h = '';
  for (let i = 0; i < n; i++)
    h += `<div class="tile skel"><div class="thumb"></div>
      <div class="meta"><div class="sk-line"></div>
      <div class="sk-line short"></div></div></div>`;
  return h;
}

/* ===== URL <-> state ================================================ */
/* The address bar mirrors the view so the browser's back/forward
   buttons work and any view can be bookmarked or refreshed. */
function buildParams(page){
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  p.set('sort', state.sort);
  if (state.sort === 'random' && state.seed) p.set('seed', state.seed);
  p.set('page', page);
  for (const f of facetOf())
    for (const v of state.filters[f]) p.append(f, v);
  if (state.lorasOnly) p.set('loras', '1');
  appendFavKinds(p);
  return p;
}

function urlFor(page){
  const p = new URLSearchParams();
  // Always include `mode` so the gallery URL never collapses to a bare
  // "/" -- which is now the marketing landing page.
  p.set('mode', state.mode);
  if (state.q) p.set('q', state.q);
  if (state.sort !== 'count') p.set('sort', state.sort);
  if (state.sort === 'random' && state.seed) p.set('seed', state.seed);
  if (page > 1) p.set('page', page);
  for (const f of facetOf())
    for (const v of state.filters[f]) p.append(f, v);
  if (state.lorasOnly) p.set('loras', '1');
  appendFavKinds(p);
  const qs = p.toString();
  return location.pathname + (qs ? '?' + qs : '');
}

function syncURL(page, push){
  const url = urlFor(page);
  if (push) history.pushState({}, '', url);
  else history.replaceState({}, '', url);
}

/* Sort options are per-view: Score only makes sense for Artists, and
   "Recently Added" (when you hearted it) only exists for Favourites --
   so a sort carried over from another view falls back to Image Count. */
function syncSortControls(){
  if (state.sort === 'score' && state.mode !== 'artists')
    state.sort = 'count';
  if (state.sort === 'recent' && state.mode !== 'favourites')
    state.sort = 'count';
  if (state.mode === 'favourites' && state.sort === 'count')
    state.sort = 'recent';
  const sortEl = $('#sort');
  sortEl.querySelector('[data-sort="score"]').hidden =
    state.mode !== 'artists';
  sortEl.querySelector('[data-sort="recent"]').hidden =
    state.mode !== 'favourites';
  sortEl.querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.sort === state.sort));
}

/* restore the whole view from the current URL (initial load + back/fwd) */
function applyURL(){
  const p = new URLSearchParams(location.search);
  const mode = p.get('mode');
  state.mode = MODES[mode] ? mode : 'characters';
  state.q = p.get('q') || '';
  const sortParam = p.get('sort');
  state.sort = (sortParam === 'az' || sortParam === 'score'
                || sortParam === 'random' || sortParam === 'recent')
    ? sortParam : 'count';
  const seedParam = parseInt(p.get('seed'), 10);
  state.seed = (state.sort === 'random' && seedParam > 0) ? seedParam : null;
  state.lorasOnly = p.get('loras') === '1';
  state.favKinds = p.has('kind')
    ? new Set(p.getAll('kind')
        .filter(v => v === 'characters' || v === 'artists'))
    : new Set(['characters', 'artists']);
  state.filters = freshFilters(state.mode);
  state.labels = {};
  for (const f of facetOf()){
    for (const v of p.getAll(f)){
      state.filters[f].add(v);
      if (!state.labels[v]) state.labels[v] = v;   // slug until facets load
    }
  }
  const page = Math.max(1, parseInt(p.get('page') || '1', 10) || 1);

  $('#q').value = state.q;
  $('#modeswitch').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.mode === state.mode));
  browseMenu.querySelectorAll('[data-browse]').forEach(b =>
    b.classList.toggle('on', b.dataset.browse === state.mode));
  syncSortControls();
  syncFavBtn();
  document.body.classList.toggle('no-sidebar', facetOf().length === 0);

  refreshChips();
  loadFacets();
  runSearch(page);
  window.scrollTo({ top: 0 });
}

/* ===== search + pagination ========================================== */
let searchSeq = 0;

async function runSearch(page){
  state.page = page;
  const seq = ++searchSeq;
  gallery.innerHTML = skeletons(24);
  statusEl.innerHTML = '';
  pagerEl.innerHTML = '';

  try {
    const data = await fetch(apiURL('/search?') + buildParams(page))
      .then(r => r.json());
    if (seq !== searchSeq) return;          // a newer search superseded us

    gallery.innerHTML = data.results.map(tileHTML).join('');
    applyTagState();
    applyRegenState();
    loraData = {};
    for (const c of data.results)
      if (c.loras && c.loras.length) loraData[c.slug] = c.loras;
    hideLoraPanel();
    state.total = data.total;
    state.pages = data.pages;

    renderResultCount();
    renderEmptyState();
    renderPager();
  } catch (e){
    if (seq !== searchSeq) return;
    statusEl.innerHTML =
      `<div class="big">⚠</div><div class="t1">Could not load results</div>
       <div class="t2">Is the server still running?</div>`;
  }
}

/* The two status lines, split out so removing a tile from the
   favourites page can refresh them without a second server round-trip. */
function renderResultCount(){
  const noun = MODES[state.mode].noun;
  resultEl.innerHTML =
    `<b>${state.total.toLocaleString()}</b> ${noun}` +
    (state.total === 1 ? '' : 's') +
    (state.pages > 1 ? ` · page ${state.page} of ${state.pages}` : '');
}

function renderEmptyState(){
  const noun = MODES[state.mode].noun;
  if (state.total > 0){ statusEl.innerHTML = ''; return; }

  if (state.mode === 'favourites' && favTotal === 0){
    statusEl.innerHTML = `<div class="big">♡</div>
      <div class="t1">Nothing favourited yet</div>
      <div class="t2">Tap the ♥ in the corner of any tile and it will
        show up here.</div>`;
    return;
  }
  // An empty list here is the filter's doing, not an empty database, so
  // say so -- otherwise it reads as if the favourites had gone missing.
  if (state.mode === 'favourites' && state.favKinds.size === 0){
    statusEl.innerHTML = `<div class="big">⊘</div>
      <div class="t1">Both types are hidden</div>
      <div class="t2">Tick Characters or Artists above to see your
        favourites again.</div>`;
    return;
  }
  statusEl.innerHTML = `<div class="big">⊘</div>
    <div class="t1">No ${noun}s match</div>
    <div class="t2">${state.mode === 'favourites'
      ? 'Try a different search, or show both types above.'
      : 'Try a different search or clear some filters.'}</div>`;
}

/* run a query, update the address bar, and jump to the top.
   push=false (the default is true) updates the URL without a history
   entry -- used for as-you-type search so back doesn't step per keystroke */
function go(page, push){
  runSearch(page);
  syncURL(page, push !== false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function pageBtn(label, page, opts){
  opts = opts || {};
  return `<button class="pg${opts.cls ? ' ' + opts.cls : ''}"` +
    `${opts.disabled ? ' disabled' : ''}` +
    `${page ? ` data-page="${page}"` : ''}>${label}</button>`;
}

function renderPager(){
  const { page, pages } = state;
  if (pages <= 1){ pagerEl.innerHTML = ''; return; }

  const out = [pageBtn('‹ Prev', page - 1, { disabled: page <= 1 })];
  const nums = [];
  const add = p => {
    if (p >= 1 && p <= pages && !nums.includes(p)) nums.push(p);
  };
  add(1); add(2);
  for (let p = page - 1; p <= page + 1; p++) add(p);
  add(pages - 1); add(pages);
  nums.sort((a, b) => a - b);

  let prev = 0;
  for (const p of nums){
    if (p - prev > 1) out.push('<span class="pg-gap">…</span>');
    out.push(pageBtn(p, p, { cls: p === page ? 'on' : '' }));
    prev = p;
  }
  out.push(pageBtn('Next ›', page + 1, { disabled: page >= pages }));
  pagerEl.innerHTML = out.join('');
}

/* ===== facets / sidebar ============================================= */
let facetLists = {};   // name -> <div class="flist">
let facetHints = {};   // name -> <div class="fhint">

function optionHTML(name, v){
  const on = state.filters[name].has(v.value);
  return `<label class="fopt ${on ? 'on' : ''}">
    <input type="checkbox" value="${esc(v.value)}"
           data-facet="${name}" data-label="${esc(v.label)}"
           ${on ? 'checked' : ''}>
    <span class="box"></span>
    <span class="fl" title="${esc(v.label)}">${esc(v.label)}</span>
    <span class="fc">${v.count == null ? '' : fmt(v.count)}</span>
  </label>`;
}

function renderOptions(name, values, total){
  // Capture proper labels for any selected values shown here (e.g. a
  // filter restored from the URL as a bare slug).
  let labelChanged = false;
  for (const v of values){
    if (state.filters[name].has(v.value) &&
        state.labels[v.value] !== v.label){
      state.labels[v.value] = v.label;
      labelChanged = true;
    }
  }

  const shown = new Set(values.map(v => v.value));
  const pinned = [...state.filters[name]]
    .filter(v => !shown.has(v))
    .map(v => ({ value: v, label: state.labels[v] || v, count: null }));
  const all = [...pinned, ...values];
  facetLists[name].innerHTML = all.length
    ? all.map(v => optionHTML(name, v)).join('')
    : '<div class="fempty">no matches</div>';

  const hint = facetHints[name];
  if (total != null && total > values.length){
    hint.textContent =
      `${total.toLocaleString()} in total — type above to find more`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
  if (labelChanged) refreshChips();
}

function buildFacetGroup(name, def){
  const open = DEFAULT_OPEN.has(name);
  // A search box only helps when there are more values than are shown
  // (Character / Copyright / Artist). The small trait facets list
  // everything already, so they get no box.
  const searchable = def.total > def.values.length;
  const wrap = document.createElement('div');
  wrap.className = 'fgroup' + (open ? '' : ' collapsed') +
                   (searchable ? ' searchable' : '');
  wrap.dataset.facet = name;
  wrap.innerHTML = `
    <button class="fgroup-head" type="button">
      <span class="ti">${esc(def.label)}</span>
      <span class="badge-n" data-count="${name}" hidden></span>
      <span class="caret">▾</span>
    </button>
    <div class="fgroup-body">
      ${searchable ? `<input class="fsearch" placeholder="Type to search…"
                            data-facet="${name}">` : ''}
      <div class="flist"></div>
      <div class="fhint" hidden></div>
    </div>`;
  facetsEl.appendChild(wrap);

  facetLists[name] = wrap.querySelector('.flist');
  facetHints[name] = wrap.querySelector('.fhint');
  renderOptions(name, def.values, def.total);

  wrap.querySelector('.fgroup-head')
      .addEventListener('click', () => wrap.classList.toggle('collapsed'));

  const search = wrap.querySelector('.fsearch');
  if (search) search.addEventListener('input', debounce(async () => {
    try {
      const res = await fetch(
        apiURL('/facet/' + name) +
        '?q=' + encodeURIComponent(search.value.trim()));
      const data = await res.json();
      renderOptions(name, data.values, data.total);
    } catch {/* keep current list */}
  }, 220));
}

async function reloadFacet(name){
  if (!facetLists[name]) return;
  try {
    const res = await fetch(apiURL('/facet/' + name) + '?q=');
    const data = await res.json();
    renderOptions(name, data.values, data.total);
  } catch {/* leave as-is */}
}

async function loadFacets(){
  facetsEl.innerHTML = '';
  facetLists = {};
  facetHints = {};
  const data = await (await fetch(apiURL('/facets'))).json();
  for (const name of facetOf())
    if (data.facets[name]) buildFacetGroup(name, data.facets[name]);
  $('#q').placeholder = MODES[state.mode].placeholder(
    (data.total || 0).toLocaleString());
  $('#sort').querySelector('[data-sort="count"]').textContent =
    MODES[state.mode].countLabel;
  $('#artist-note').hidden = state.mode !== 'artists';
  $('#fav-note').hidden = state.mode !== 'favourites';
  const lf = $('#loras-filter');
  lf.hidden = state.mode !== 'characters';
  $('#loras-only').checked = state.lorasOnly;
  lf.classList.toggle('on', state.lorasOnly);
  if (DEV){
    $('#devbar').hidden = state.mode !== 'artists';
    $('#devbar-regen').hidden = state.mode !== 'characters';
    if (state.mode === 'artists'){
      await loadDevCategories();
      await setActiveCat(state.activeCat);
    }
    setRegenMode(state.regenMode);
  }
}

/* ===== active filter chips ========================================== */
function refreshChips(){
  const chips = [];
  let count = 0;
  for (const f of facetOf()){
    for (const v of state.filters[f]){
      count++;
      chips.push(`<span class="achip" data-facet="${f}"
        data-value="${esc(v)}">
        <span class="cat">${FACET_LABELS[f]}</span>
        ${esc(state.labels[v] || v)}<span class="x">✕</span></span>`);
    }
  }
  chipsEl.innerHTML = chips.join('');
  clearBtn.hidden = count === 0 && !state.q && !state.lorasOnly;

  for (const f of facetOf()){
    const b = document.querySelector(`[data-count="${f}"]`);
    if (!b) continue;
    const n = state.filters[f].size;
    b.hidden = n === 0;
    b.textContent = n;
  }
}

function toggleFilter(facet, value, label, on){
  const set = state.filters[facet];
  if (on){ set.add(value); state.labels[value] = label; }
  else     set.delete(value);
  refreshChips();
  go(1);
}

/* tick a facet value from elsewhere (e.g. a tile's series label) */
function applyFilter(facet, value, label){
  state.filters[facet].add(value);
  state.labels[value] = label;
  refreshChips();
  reloadFacet(facet);            // re-render the sidebar group so it ticks
  go(1);
}

/* drop a tag into the search box (comma-separated -> AND-ed), then go */
function addToSearch(text){
  const box = $('#q');
  const cur = box.value.trim();
  const pieces = cur ? cur.split(',').map(p => p.trim().toLowerCase()) : [];
  const tl = text.toLowerCase();
  const next = pieces.includes(tl)
    ? cur
    : (cur ? cur + ', ' + text : text);
  box.value = next;
  state.q = next;
  refreshChips();
  go(1);
  toast('Searching ' + text);
}

/* ===== preview modal ================================================ */
const modal     = $('#modal');
const modalImg  = $('#modal-img');
const modalName = $('#modal-name');
const modalSub  = $('#modal-sub');

function openPreview(tile){
  modal.classList.add('loading');
  modalImg.removeAttribute('src');
  modalName.textContent = tile.querySelector('.name').textContent;
  const sub = tile.querySelector('.copyright, .subtag, .scorebadge');
  modalSub.textContent = sub ? sub.textContent : '';
  modal.hidden = false;
  document.body.classList.add('noscroll');
  // URL was attached to the tile at render time so the same code
  // works against any backend (Flask returns a /img/<mode>/<slug>
  // path, the worker returns an absolute R2 URL).
  modalImg.src = tile.dataset.imgUrl || '';
}
function closePreview(){
  modal.hidden = true;
  modalImg.removeAttribute('src');
  document.body.classList.remove('noscroll');
}
modalImg.addEventListener('load',  () => modal.classList.remove('loading'));
modalImg.addEventListener('error', () => modal.classList.remove('loading'));
modal.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) closePreview();
});

/* ===== dataset / browse switching =================================== */
function switchMode(mode, preset){
  if (!MODES[mode]) return;
  if (mode === state.mode && !preset) return;
  state.mode = mode;
  state.q = '';
  $('#q').value = '';
  state.filters = freshFilters(mode);
  state.labels = {};
  state.lorasOnly = false;
  state.favKinds = new Set(['characters', 'artists']);
  if (preset){                          // pre-apply a filter (e.g. series)
    state.filters[preset.facet] = new Set([preset.value]);
    state.labels[preset.value] = preset.label;
  }
  $('#modeswitch').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.mode === mode));
  browseMenu.querySelectorAll('[data-browse]').forEach(b =>
    b.classList.toggle('on', b.dataset.browse === mode));
  document.body.classList.toggle('no-sidebar',
    MODES[mode].facets.length === 0);
  syncSortControls();
  syncFavBtn();
  refreshChips();
  loadFacets();
  go(1);
}

/* ===== dev mode: hand-curated artist categories ===================== */
const devSel  = $('#dev-cat');
const devHint = $('#dev-hint');

async function loadDevCategories(){
  if (!DEV) return;
  let values = [];
  try {
    values = ((await (await fetch('/api/artists/facet/category')).json())
              .values) || [];
  } catch {/* leave the list empty */}
  devSel.innerHTML = '<option value="">— pick a classification —</option>' +
    values.map(v =>
      `<option value="${esc(v.value)}">${esc(v.label)} · ${v.count}</option>`)
      .join('');
  devSel.value = state.activeCat;
}

async function setActiveCat(name){
  state.activeCat = name;
  if (name){
    try {
      const data = await (await fetch('/api/dev/category/members?name=' +
        encodeURIComponent(name))).json();
      state.catMembers = new Set(data.members || []);
    } catch { state.catMembers = new Set(); }
  } else {
    state.catMembers = new Set();
  }
  devHint.textContent = name
    ? `Click an artist tile to tag / untag it as "${name}".`
    : 'Pick or add a classification, then click tiles to tag them.';
  applyTagState();
}

/* highlight the rendered tiles that belong to the active category */
function applyTagState(){
  const live = DEV && state.mode === 'artists' && !!state.activeCat;
  gallery.classList.toggle('tagging', live);
  gallery.querySelectorAll('.tile').forEach(t =>
    t.classList.toggle('tagged',
      live && state.catMembers.has(t.dataset.slug)));
}

async function toggleArtistCategory(tile){
  const slug = tile.dataset.slug, cat = state.activeCat;
  try {
    const res = await fetch('/api/dev/category/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist: slug, category: cat }),
    });
    if (!res.ok) throw 0;
    const data = await res.json();
    if (data.member) state.catMembers.add(slug);
    else state.catMembers.delete(slug);
    tile.classList.toggle('tagged', data.member);
    toast(data.member ? `Tagged "${cat}"` : `Removed from "${cat}"`);
  } catch { toast('Could not update classification'); }
}

async function devAddCategory(){
  const box = $('#dev-new'), name = box.value.trim();
  if (!name) return;
  try {
    const res = await fetch('/api/dev/category/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw 0;
    box.value = '';
    await loadDevCategories();
    devSel.value = name;
    await setActiveCat(name);
    reloadFacet('category');
    toast(`Classification "${name}" added`);
  } catch { toast('Could not add classification'); }
}

async function devDeleteCategory(){
  const name = devSel.value;
  if (!name){ toast('Pick a classification to delete first'); return; }
  if (!confirm(`Delete classification "${name}"? ` +
               'It will be removed from every artist.')) return;
  try {
    const res = await fetch('/api/dev/category/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw 0;
    await setActiveCat('');
    await loadDevCategories();
    reloadFacet('category');
    toast(`Classification "${name}" deleted`);
  } catch { toast('Could not delete classification'); }
}

if (DEV){
  devSel.addEventListener('change', () => setActiveCat(devSel.value));
  $('#dev-add').addEventListener('click', devAddCategory);
  $('#dev-new').addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); devAddCategory(); }
  });
  $('#dev-del').addEventListener('click', devDeleteCategory);
}

/* ----- dev: regenerate a character render --------------------------- */
let regenSlug = '', regenTile = null;

function setRegenMode(on){
  state.regenMode = on;
  $('#regen-toggle').classList.toggle('on', on);
  gallery.classList.toggle('regen-mode', on && state.mode === 'characters');
  $('#regen-hint').textContent = on
    ? 'Click a character to edit its prompt and regenerate.' : '';
}

function openRegen(tile){
  regenSlug = tile.dataset.slug;
  regenTile = tile;
  const trigEl = tile.querySelector('.ov-trigger');
  const trigger = trigEl ? trigEl.textContent.trim() : '';
  const tags = [...tile.querySelectorAll('.ov-tags .tag')]
    .map(t => t.textContent.trim());
  $('#regen-title').textContent =
    'Regenerate · ' + tile.querySelector('.name').textContent;
  $('#regen-tags').value = [trigger, ...tags].filter(Boolean).join(', ');
  const st = $('#regen-status');
  st.textContent = ''; st.className = 'regen-status';
  $('#regen-go').disabled = false;
  $('#regen-modal').hidden = false;
  document.body.classList.add('noscroll');
  $('#regen-tags').focus();
}

function closeRegen(){
  $('#regen-modal').hidden = true;
  document.body.classList.remove('noscroll');
}

function doRegen(){
  const tags = $('#regen-tags').value.trim();
  const st = $('#regen-status');
  if (!tags){
    st.className = 'regen-status err';
    st.textContent = 'Enter some prompt tags first.';
    return;
  }
  const slug = regenSlug;
  const name = regenTile
    ? regenTile.querySelector('.name').textContent : slug;
  closeRegen();                    // free the user to carry on immediately
  startRegen(slug, tags, name);
}

/* fire a regeneration in the background -- the user can queue more */
function startRegen(slug, tags, name){
  state.regenning.add(slug);
  markTileRegen(slug, true);
  toast('Regenerating ' + name + ' …');
  fetch('/api/dev/regenerate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, tags }),
  }).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok)
      throw new Error(data.error || ('HTTP ' + res.status));
    state.regenning.delete(slug);
    finishRegen(slug, true);
    toast('Regenerated ' + name);
  }).catch(err => {
    state.regenning.delete(slug);
    finishRegen(slug, false);
    toast('Regen failed: ' + name + ' — ' + err.message);
  });
}

/* toggle the working-spinner overlay on a tile, looked up live by slug */
function markTileRegen(slug, on){
  const tile = gallery.querySelector(
    '.tile[data-slug="' + CSS.escape(slug) + '"]');
  if (!tile) return;
  tile.classList.toggle('regenerating', on);
  let spin = tile.querySelector('.regen-spin');
  if (on && !spin){
    spin = document.createElement('div');
    spin.className = 'regen-spin';
    spin.innerHTML = '<span class="regen-spinner"></span>';
    (tile.querySelector('.thumb') || tile).appendChild(spin);
  } else if (!on && spin){
    spin.remove();
  }
}

function finishRegen(slug, ok){
  markTileRegen(slug, false);
  if (!ok) return;
  const tile = gallery.querySelector(
    '.tile[data-slug="' + CSS.escape(slug) + '"]');
  const img = tile && tile.querySelector('img.shot');
  if (img) img.src = img.src.split('?')[0] + '?v=' + Date.now();
}

/* re-apply spinners after the gallery re-renders (e.g. pagination) */
function applyRegenState(){
  for (const slug of state.regenning) markTileRegen(slug, true);
}

if (DEV){
  $('#regen-toggle').addEventListener('click',
    () => setRegenMode(!state.regenMode));
  $('#regen-go').addEventListener('click', doRegen);
  $('#regen-modal').addEventListener('click', e => {
    if (e.target.id === 'regen-modal' || e.target.closest('[data-rclose]'))
      closeRegen();
  });
}

/* ===== LoRA capsule + hover panel =================================== */
let loraData = {};                 // character slug -> [{name, url, thumb}]
const loraPanel = $('#lora-panel');
let loraHideTimer = 0;
let loraPanelSlug = '';

function loraItemHTML(l){
  const thumb = l.thumb
    ? `<img class="lora-thumb" src="${esc(l.thumb)}" loading="lazy" alt=""
            onerror="this.style.display='none'">`
    : '<div class="lora-thumb"></div>';
  return `<a class="lora-item" href="${esc(l.url)}" target="_blank"
            rel="noopener">${thumb}` +
    `<span class="lora-name">${esc(l.name)}</span></a>`;
}

function openLoraPanel(tile){
  clearTimeout(loraHideTimer);
  const slug = tile.dataset.slug;
  const loras = loraData[slug];
  if (!loras) return;
  if (loraPanelSlug === slug && loraPanel.classList.contains('show')) return;
  loraPanelSlug = slug;
  loraPanel.innerHTML =
    '<div class="lora-head">AVAILABLE ON CIVITAI</div>' +
    '<div class="lora-list">' + loras.map(loraItemHTML).join('') + '</div>' +
    '<div class="lora-foot">ANIMADEX is not endorsed by CivitAI</div>';
  loraPanel.classList.remove('on-left');

  const r = tile.getBoundingClientRect();
  const W = 300, M = 12, TOP = 72;
  let left = r.right;
  if (left + W > window.innerWidth - M){       // no room -> flip to the left
    left = r.left - W;
    loraPanel.classList.add('on-left');
  }
  loraPanel.style.left = Math.max(M, left) + 'px';
  loraPanel.style.top = '-9999px';
  loraPanel.classList.add('show');
  let top = r.top;
  if (top + loraPanel.offsetHeight > window.innerHeight - M)
    top = window.innerHeight - M - loraPanel.offsetHeight;
  loraPanel.style.top = Math.max(TOP, top) + 'px';
}

function hideLoraPanel(){
  loraPanel.classList.remove('show');
  loraPanelSlug = '';
}

function scheduleHideLora(){
  clearTimeout(loraHideTimer);
  loraHideTimer = setTimeout(hideLoraPanel, 160);
}

gallery.addEventListener('mouseover', e => {
  const tile = e.target.closest('.tile');
  if (tile && loraData[tile.dataset.slug]) openLoraPanel(tile);
});
gallery.addEventListener('mouseout', e => {
  const tile = e.target.closest('.tile');
  if (tile && loraData[tile.dataset.slug]) scheduleHideLora();
});
loraPanel.addEventListener('mouseover', () => clearTimeout(loraHideTimer));
loraPanel.addEventListener('mouseout', scheduleHideLora);
window.addEventListener('scroll', hideLoraPanel, { passive: true });

if (DEV){
  $('#lora-sync-btn').addEventListener('click', async () => {
    const btn = $('#lora-sync-btn'), label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      const res = await fetch('/api/dev/sync-loras', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok)
        throw new Error(data.message || ('HTTP ' + res.status));
      toast('LoRAs synced — ' + (data.message || 'done'));
      runSearch(state.page);
    } catch (e){
      toast('LoRA sync failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

/* ===== events ======================================================= */
// "Browse by" dropdown
browseMenu.querySelector('.navmenu-btn').addEventListener('click', e => {
  e.stopPropagation();
  browseMenu.classList.toggle('open');
});
browseMenu.addEventListener('click', e => {
  const item = e.target.closest('[data-browse]');
  if (!item) return;
  browseMenu.classList.remove('open');
  switchMode(item.dataset.browse);
});
document.addEventListener('click', e => {
  if (!browseMenu.contains(e.target)) browseMenu.classList.remove('open');
});

// dataset toggle
$('#modeswitch').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (btn) switchMode(btn.dataset.mode);
});

// Favourites -- a real link so Ctrl/middle-click opens its own tab,
// but a plain click stays inside the app like the mode switch does.
$('#fav-btn').addEventListener('click', e => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  switchMode('favourites');
});

// Characters / Artists tickboxes -- narrow the list in place.
$('#fav-filters').addEventListener('change', e => {
  const cb = e.target.closest('[data-favkind]');
  if (!cb) return;
  if (cb.checked) state.favKinds.add(cb.dataset.favkind);
  else            state.favKinds.delete(cb.dataset.favkind);
  syncFavKindBoxes();
  go(1);
});

/* ----- import an exported favourites list -------------------------- */
const favImportPanel  = $('#fav-import-panel');
const favImportFile   = $('#fav-import-file');
const favImportGo     = $('#fav-import-go');
const favImportStatus = $('#fav-import-status');

function setFavImportOpen(open){
  favImportPanel.hidden = !open;
  $('#fav-import-btn').setAttribute('aria-expanded', String(open));
  if (!open) return;
  favImportStatus.textContent = '';
  favImportFile.value = '';
  $('#fav-import-replace').checked = false;
  $('#fav-import-replace').closest('.fopt').classList.remove('on');
}

$('#fav-import-btn').addEventListener('click',
  () => setFavImportOpen(favImportPanel.hidden));
$('#fav-import-cancel').addEventListener('click',
  () => setFavImportOpen(false));
$('#fav-import-replace').addEventListener('change', e =>
  e.target.closest('.fopt').classList.toggle('on', e.target.checked));

favImportGo.addEventListener('click', async () => {
  const file = favImportFile.files && favImportFile.files[0];
  if (!file){
    favImportStatus.textContent = 'Choose a file first.';
    return;
  }
  const form = new FormData();
  form.append('file', file);
  if ($('#fav-import-replace').checked) form.append('mode', 'replace');

  favImportGo.disabled = true;
  favImportStatus.textContent = 'Importing…';
  try {
    const res = await fetch('/api/favourites/import',
                            { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok)
      throw new Error(data.error || ('HTTP ' + res.status));

    // The server is the source of truth for hearts, counts and order.
    await loadFavourites();
    runSearch(state.page);

    const bits = [data.added + ' added'];
    if (data.existing)  bits.push(data.existing + ' already hearted');
    if (data.duplicate) bits.push(data.duplicate + ' repeated in the file');
    if (data.unknown)   bits.push(data.unknown + ' not in this catalogue');
    favImportStatus.textContent = bits.join(', ') + '.';
    toast('Imported ' + data.added + ' favourite' +
          (data.added === 1 ? '' : 's'));
    if (data.unknown && data.unknown_slugs && data.unknown_slugs.length)
      console.warn('Favourites not imported:', data.unknown_slugs.join(', '));
  } catch (err){
    favImportStatus.textContent = 'Import failed — ' + err.message;
  } finally {
    favImportGo.disabled = false;
  }
});

// facet checkboxes (delegated)
facetsEl.addEventListener('change', e => {
  const cb = e.target;
  if (cb.type !== 'checkbox') return;
  cb.closest('.fopt').classList.toggle('on', cb.checked);
  toggleFilter(cb.dataset.facet, cb.value, cb.dataset.label, cb.checked);
});

// "LoRAs Available" toggle (a standalone checkbox below the facets)
$('#loras-only').addEventListener('change', e => {
  state.lorasOnly = e.target.checked;
  $('#loras-filter').classList.toggle('on', e.target.checked);
  refreshChips();
  go(1);
});

// "?" help popup next to the LoRAs checkbox
(() => {
  const btn = $('#lora-help-btn');
  const pop = $('#lora-help-pop');
  const close = $('#lora-help-close');

  function place(){
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    // prefer to the right of the sidebar; fall back to the left if it
    // would overflow the viewport.
    let left = r.right + 10;
    if (left + pw > window.innerWidth - 8)
      left = Math.max(8, r.left - pw - 10);
    let top = r.top - 4;
    if (top + ph > window.innerHeight - 8)
      top = Math.max(8, window.innerHeight - 8 - ph);
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
  }
  function toggle(open){
    const want = open ?? pop.hidden;
    pop.hidden = !want;
    btn.setAttribute('aria-expanded', String(want));
    if (want) place();
  }
  btn.addEventListener('click', e => {
    // a button inside a <label> shouldn't toggle its checkbox.
    e.preventDefault(); e.stopPropagation();
    toggle();
  });
  close.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    toggle(false);
  });
  // dismiss on outside click / Escape; reposition on viewport changes.
  document.addEventListener('click', e => {
    if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target))
      toggle(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !pop.hidden) toggle(false);
  });
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
  window.addEventListener('scroll',
    () => { if (!pop.hidden) place(); }, true);
})();

// active-chip removal
chipsEl.addEventListener('click', e => {
  const chip = e.target.closest('.achip');
  if (!chip) return;
  const { facet, value } = chip.dataset;
  state.filters[facet].delete(value);
  const box = facetsEl.querySelector(
    `input[data-facet="${facet}"][value="${CSS.escape(value)}"]`);
  if (box){ box.checked = false; box.closest('.fopt').classList.remove('on'); }
  refreshChips();
  go(1);
});

// clear all
clearBtn.addEventListener('click', () => {
  state.q = '';
  $('#q').value = '';
  state.filters = freshFilters(state.mode);
  state.lorasOnly = false;
  $('#loras-only').checked = false;
  $('#loras-filter').classList.remove('on');
  facetsEl.querySelectorAll('input:checked').forEach(b => {
    b.checked = false; b.closest('.fopt').classList.remove('on');
  });
  refreshChips();
  go(1);
});

// search submits on Enter or the magnifying-glass button; typing no
// longer fires a request per keystroke. The input still auto-clears when
// the box is emptied (the native X / select-all + delete).
function submitSearch(){
  state.q = $('#q').value.trim();
  refreshChips();
  go(1);
}
$('#q').addEventListener('keydown', e => {
  if (e.key === 'Enter'){ e.preventDefault(); submitSearch(); }
});
$('#q').addEventListener('input', e => {
  if (!e.target.value && state.q){       // box was just emptied
    state.q = '';
    refreshChips();
    go(1, false);
  }
});
$('#search-go').addEventListener('click', submitSearch);

// sort toggle -- re-clicking 'random' reshuffles with a new seed.
$('#sort').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const sort = btn.dataset.sort;
  if (sort === 'random'){
    state.sort  = 'random';
    state.seed  = Math.floor(Math.random() * 2147483646) + 1;
  } else {
    if (btn.classList.contains('on')) return;
    state.sort = sort;
    state.seed = null;
  }
  $('#sort').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.sort === state.sort));
  go(1);
});

// gallery: browse to a series, preview, search a tag, filter, or copy
gallery.addEventListener('click', e => {
  const tile = e.target.closest('.tile');
  if (!tile) return;

  // The heart sits inside the thumbnail, ahead of everything else that
  // claims a click (dev-mode tile clicks, the copy buttons below).
  if (e.target.closest('.tile-fav-btn')){
    e.preventDefault();
    toggleFavourite(tile);
    return;
  }

  // DEV: with a category active, a plain click on an artist tile toggles
  // its membership (the overlay buttons and links still work normally).
  if (DEV && state.mode === 'artists' && state.activeCat &&
      !e.target.closest('.actbtn, .copybtn, a')){
    toggleArtistCategory(tile);
    return;
  }

  // DEV: in regen mode, clicking a character tile opens the prompt editor
  if (DEV && state.mode === 'characters' && state.regenMode &&
      !e.target.closest('.actbtn, .copybtn, a')){
    openRegen(tile);
    return;
  }

  if (state.mode === 'copyrights'){
    switchMode('characters', { facet: 'copyright',
      value: tile.dataset.slug, label: tile.dataset.name });
    return;
  }

  if (e.target.closest('.previewbtn')){ openPreview(tile); return; }

  const tag = e.target.closest('.tag');
  if (tag){
    addToSearch(tag.textContent.trim());
    return;
  }

  const series = e.target.closest('.copyright');
  if (series){
    // a modified click (Ctrl/Cmd/Shift/Alt) -- and middle-click, which
    // never fires 'click' -- falls through to the browser so the link
    // opens in a new tab/window.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();          // plain click -> filter in-app, no reload
    // The favourites list has no series filter of its own, so a series
    // link there jumps to the character view already narrowed to it.
    if (state.mode === 'favourites'){
      switchMode('characters', { facet: 'copyright',
        value: series.dataset.copyright,
        label: series.textContent.trim() });
      return;
    }
    applyFilter('copyright', series.dataset.copyright,
                series.textContent.trim());
    return;
  }

  const copy = e.target.closest('.copybtn');
  if (!copy) return;
  const trigger = escParens(tile.querySelector('.ov-trigger').textContent);
  if (copy.dataset.copy === 'all'){
    const tags = [...tile.querySelectorAll('.ov-tags .tag')]
      .map(t => escParens(t.textContent));
    copyText(trigger + ', ' + tags.join(', '), 'Trigger + tags copied');
  } else {
    copyText(trigger, state.mode === 'artists'
      ? 'Artist tag copied' : 'Trigger copied');
  }
});

// pager
pagerEl.addEventListener('click', e => {
  const btn = e.target.closest('.pg[data-page]');
  if (btn && !btn.disabled) go(Number(btn.dataset.page));
});

// keyboard: "/" focuses search, Escape closes modal / clears search
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modal.hidden){ closePreview(); return; }
  if (e.key === 'Escape' && !$('#regen-modal').hidden){ closeRegen(); return; }
  if (e.key === 'Escape' && !$('#contact-modal').hidden){ closeContact(); return; }
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing){ e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape' && document.activeElement === $('#q')){
    $('#q').value = ''; state.q = ''; refreshChips(); go(1);
  }
});

// browser back / forward -- restore the view from the URL
window.addEventListener('popstate', applyURL);

/* ===== contact form ================================================= */
const contactModal = $('#contact-modal');
const contactForm = $('#contact-form');
const contactReason = $('#contact-reason');
const contactStatus = $('#contact-status');
const contactQuestion = $('#contact-question');
const contactAnswer = $('#contact-answer');

const LORA_HINT = 'For a LoRA takedown please include the LoRA name and '
  + 'a link to its CivitAI page in the message.';

async function loadCaptcha(){
  contactQuestion.textContent = '…';
  try {
    const d = await (await fetch('/api/contact/captcha')).json();
    contactQuestion.textContent = d.question + ' =';
    contactForm.dataset.token = d.token;
    contactForm.dataset.expires = d.expires;
  } catch {
    contactQuestion.textContent = '(captcha failed to load)';
  }
}

async function openContact(){
  contactForm.reset();
  contactStatus.textContent = '';
  contactStatus.className = 'cmodal-status';
  $('#contact-hint').hidden = true;
  $('#contact-honey').value = '';
  contactModal.hidden = false;
  document.body.classList.add('noscroll');
  await loadCaptcha();
  contactReason.focus();
}

function closeContact(){
  contactModal.hidden = true;
  document.body.classList.remove('noscroll');
}

$('#contact-open').addEventListener('click', openContact);
contactReason.addEventListener('change', () => {
  const isLora = contactReason.value === 'lora_takedown';
  const h = $('#contact-hint');
  h.textContent = LORA_HINT;
  h.hidden = !isLora;
});
contactModal.addEventListener('click', e => {
  if (e.target === contactModal || e.target.closest('[data-cclose]'))
    closeContact();
});
contactForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submitBtn = contactForm.querySelector('button[type=submit]');
  contactStatus.className = 'cmodal-status';
  contactStatus.textContent = 'Sending…';
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: contactReason.value,
        message: $('#contact-message').value,
        answer: contactAnswer.value,
        token: contactForm.dataset.token,
        expires: Number(contactForm.dataset.expires),
        honeypot: $('#contact-honey').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok)
      throw new Error(data.error || ('HTTP ' + res.status));
    contactStatus.className = 'cmodal-status ok';
    contactStatus.textContent = 'Thanks — message sent.';
    toast('Message sent');
    setTimeout(closeContact, 1200);
  } catch (err) {
    contactStatus.className = 'cmodal-status err';
    contactStatus.textContent = err.message;
    loadCaptcha();              // refresh the captcha on failure
  } finally {
    submitBtn.disabled = false;
  }
});

/* ===== mobile drawer ================================================ */
/* Below 760px the modeswitch / sort / Browse-by menu are reparented
   from the topbar into the sidebar, and the sidebar becomes a fixed
   slide-in drawer. We move the actual DOM nodes (not clones) so every
   existing event listener on them keeps working without rebinding. */
(() => {
  const mql       = window.matchMedia('(max-width: 760px)');
  const topbar    = document.querySelector('.topbar');
  const sidebar   = $('#sidebar');
  const searchEl  = topbar.querySelector('.search');
  const sidebarTitle = sidebar.querySelector('.sidebar-title');
  const modeswitch = $('#modeswitch');
  const sort       = $('#sort');
  const navmenu    = $('#browsemenu');

  // Original positions so we can restore them when crossing back.
  const home = {
    modeswitch: { parent: topbar, before: searchEl },
    sort:       { parent: topbar, before: null      },   // last child
    navmenu:    { parent: topbar, before: modeswitch },
  };

  let layout = null;   // 'mobile' | 'desktop'

  function toMobile(){
    // Insert in REVERSE so the final on-screen order is
    // modeswitch -> sort -> navmenu -> (sidebar-title -> facets).
    sidebar.insertBefore(navmenu,    sidebarTitle);
    sidebar.insertBefore(sort,       navmenu);
    sidebar.insertBefore(modeswitch, sort);
  }
  function toDesktop(){
    closeDrawer();
    for (const [key, pos] of Object.entries(home)){
      const el = { modeswitch, sort, navmenu }[key];
      if (pos.before) pos.parent.insertBefore(el, pos.before);
      else            pos.parent.appendChild(el);
    }
  }
  function applyLayout(){
    const want = mql.matches ? 'mobile' : 'desktop';
    if (want === layout) return;
    (want === 'mobile' ? toMobile : toDesktop)();
    layout = want;
  }

  // Drawer open / close
  const toggleBtn = $('#filters-toggle');
  const closeBtn  = $('#sidebar-close');
  const backdrop  = $('#sidebar-backdrop');
  function setDrawer(open){
    document.body.classList.toggle('drawer-open', open);
    toggleBtn.setAttribute('aria-expanded', String(open));
  }
  function openDrawer(){ setDrawer(true); }
  function closeDrawer(){ setDrawer(false); }

  toggleBtn.addEventListener('click', () => {
    setDrawer(!document.body.classList.contains('drawer-open'));
  });
  closeBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' &&
        document.body.classList.contains('drawer-open')) closeDrawer();
  });

  mql.addEventListener('change', applyLayout);
  applyLayout();
})();


/* ===== boot ========================================================= */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
(async () => {
  // The hearted slugs must be known before the first gallery render, or
  // every tile would paint unhearted and then flicker on.
  await loadFavourites();
  applyURL();
})();
