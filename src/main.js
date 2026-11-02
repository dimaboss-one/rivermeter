import * as maplibregl from 'maplibre-gl';
import { RiverGraph } from './graph.js';
import { loadRivers, loadObstacles, locateObjects } from './overpass.js';
import { baseStyle, exportPdf } from './pdf.js';
import { nkey, toRu, riverRu } from './names.js';
import { fmtKm, haversine, projectOnSegment } from './geo.js';

const $ = (id) => document.getElementById(id);
const graph = new RiverGraph();
const loaded = []; // уже загруженные bbox [w,s,e,n]
let wps = [];      // {id, lonlat, marker}
let legs = [];     // {coords, length}
let route = null;  // {coords, cum}
let objects = [];
let seq = 0;

maplibregl.setWorkerUrl(import.meta.env.BASE_URL + 'maplibre-gl-worker.mjs');
const map = new maplibregl.Map({ container: 'map', style: baseStyle, center: [27.56, 53.9], zoom: 11, canvasContextAttributes: { preserveDrawingBuffer: true } });
map.addControl(new maplibregl.NavigationControl());
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }));

const status = (t) => ($('status').textContent = t);
const inside = (b, o) => b[0] <= o[0] && b[1] <= o[1] && b[2] >= o[2] && b[3] >= o[3];
const empty = { type: 'FeatureCollection', features: [] };

map.on('load', () => {
  map.addSource('rivers', { type: 'geojson', data: empty });
  map.addLayer({ id: 'rivers', type: 'line', source: 'rivers', paint: { 'line-color': '#1e88e5', 'line-width': 1.5, 'line-opacity': 0.6 } });
  map.addSource('route', { type: 'geojson', data: empty });
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#8e24aa', 'line-width': 5 } });
  restore();
  loadView();
});

function drawRivers() {
  map.getSource('rivers').setData({
    type: 'FeatureCollection',
    features: [...graph.ways.values()].map((ids) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ids.map((i) => graph.nodes.get(i)) } })),
  });
}

async function ensureRivers(b) {
  if (loaded.some((l) => inside(l, b))) return;
  status('Загружаю реки…');
  const ways = await loadRivers(b);
  ways.forEach((w) => graph.addWay(w.id, w.coords, { n: w.name, ru: w.ru }));
  loaded.push(b);
  drawRivers();
  status(`Рек загружено: ${graph.ways.size} участков.`);
}

async function loadView() {
  if (map.getZoom() < 11) return status('Приблизьтесь (масштаб 11+), чтобы загрузить реки.');
  const b = map.getBounds();
  try { await ensureRivers([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]); }
  catch (e) { status('Ошибка загрузки рек: ' + e.message); }
}
map.on('moveend', loadView);

map.on('click', async (e) => {
  const p = [e.lngLat.lng, e.lngLat.lat];
  if (map.getZoom() < 11) return status('Приблизьтесь к реке (масштаб 11+).');
  const ins = insertMode;
  if (ins) setInsert(false);
  await addPoint(p, ins);
});

// радиус притягивания: 40 px экрана в метрах
function snapRadius() {
  const mpp = (78271.517 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
  return Math.max(30, 40 * mpp);
}

let insertMode = false;

async function addPoint(p, insert = false) {
  let s = graph.snap(p, snapRadius());
  if (!s) {
    try { await ensureRivers([p[0] - 0.012, p[1] - 0.008, p[0] + 0.012, p[1] + 0.008]); }
    catch (err) { return status('Ошибка загрузки рек: ' + err.message + '. Нажмите ещё раз.'); }
    s = graph.snap(p, snapRadius());
  }
  if (!s) return status('Рядом с кликом нет реки в загруженных данных. Кликните ближе к синей линии реки.');
  if (insert && wps.length >= 2) {
    // вставка внутрь маршрута: ищем отрезок между точками, ближайший к клику
    let bi = 0, bd = Infinity;
    legs.forEach((leg, i) => {
      for (let k = 1; k < leg.coords.length; k++) {
        const d = projectOnSegment(s.point, leg.coords[k - 1], leg.coords[k]).dist;
        if (d < bd) { bd = d; bi = i; }
      }
    });
    const nw = { id: s.id, lonlat: s.point, river: wps[0].river, marker: makeMarker(s.point) };
    wps.splice(bi + 1, 0, nw);
    if (!rebuildLegs()) { wps.splice(bi + 1, 1); nw.marker.remove(); rebuildLegs(); return status('Нельзя вставить: нет пути по реке через эту точку.'); }
    refresh();
    return;
  }
  const prev = wps.at(-1);
  if (prev) {
    const leg = graph.path(prev.id, s.id);
    if (!leg) return status('Между точками нет пути по реке (разные водотоки или разрыв в данных).');
    legs.push(leg);
  }
  wps.push({ id: s.id, lonlat: s.point, river: riverRu(s.meta), marker: makeMarker(s.point) });
  refresh();
}

function makeMarker(lonlat) {
  const el = document.createElement('div');
  el.className = 'wp';
  el.addEventListener('click', (e) => e.stopPropagation());
  const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lonlat).addTo(map);
  const pop = new maplibregl.Popup({ offset: 16 });
  pop.on('open', () => {
    const i = wps.findIndex((w) => w.marker === m);
    if (i < 0) return;
    const box = document.createElement('div');
    box.innerHTML = `<b>Точка ${i + 1}</b><br>${fmtKm(wps[i].fromStart || 0)} от старта${i ? `<br>+${fmtKm(wps[i].fromPrev)} от прошлой` : ''}<br>`;
    const b = document.createElement('button');
    b.textContent = '🗑 Удалить точку';
    b.onclick = () => { pop.remove(); removeWp(m); };
    box.append(b);
    pop.setDOMContent(box);
  });
  m.setPopup(pop);
  m.on('dragend', () => {
    const i = wps.findIndex((w) => w.marker === m);
    const ll = m.getLngLat();
    const s = graph.snap([ll.lng, ll.lat], snapRadius());
    if (!s) { m.setLngLat(wps[i].lonlat); return; }
    const old = wps[i];
    wps[i] = { ...old, id: s.id, lonlat: s.point, river: riverRu(s.meta) };
    if (!rebuildLegs()) { wps[i] = old; rebuildLegs(); m.setLngLat(old.lonlat); status('Нет пути по реке для этой точки.'); return; }
    m.setLngLat(s.point);
    refresh();
  });
  return m;
}

function removeWp(m) {
  const i = wps.findIndex((w) => w.marker === m);
  if (i < 0) return;
  const old = wps.slice();
  wps.splice(i, 1);
  if (!rebuildLegs()) { wps = old; rebuildLegs(); return status('Нельзя удалить: без этой точки нет пути по реке.'); }
  m.remove();
  refresh();
}

function setInsert(on) {
  insertMode = on;
  $('ins').classList.toggle('on', on);
  if (on) status('Режим вставки: кликните по реке между точками — там появится новая точка.');
}

function rebuildLegs() {
  const nl = [];
  for (let i = 1; i < wps.length; i++) {
    const leg = graph.path(wps[i - 1].id, wps[i].id);
    if (!leg) return false;
    nl.push(leg);
  }
  legs = nl;
  return true;
}

let obstacleTimer;
function refresh() {
  // общая линия
  const coords = [], cum = [];
  let acc = 0;
  const pointDist = [0];
  legs.forEach((leg) => {
    leg.coords.forEach((c, i) => {
      if (coords.length) acc += haversine(coords.at(-1), c);
      coords.push(c); cum.push(acc);
    });
    pointDist.push(acc);
  });
  route = coords.length > 1 ? { coords, cum } : null;
  map.getSource('route').setData(route ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } : empty);

  wps.forEach((w, i) => {
    w.fromStart = pointDist[i] ?? 0;
    w.fromPrev = i ? w.fromStart - pointDist[i - 1] : 0;
    const el = w.marker.getElement();
    el.innerHTML = `${i + 1}<span>${fmtKm(w.fromStart)}${i ? `<br>+${fmtKm(w.fromPrev)}` : ''}</span>`;
  });
  renderObjects();
  updateLevels();
  $('total').textContent = route ? 'Всего: ' + fmtKm(acc) : '';
  $('pts').innerHTML = '<tr><th>№<th>От старта<th>От прошлой</tr>' +
    wps.map((w, i) => `<tr><td>${i + 1}<td>${fmtKm(w.fromStart)}<td>${i ? fmtKm(w.fromPrev) : '—'}`).join('');
  save();
  clearTimeout(obstacleTimer);
  if (route) obstacleTimer = setTimeout(findObjects, 800);
  else { objects = []; renderObjects(); }
}

let findSeq = 0;
async function findObjects() {
  const my = ++findSeq;
  const xs = route.coords.map((c) => c[0]), ys = route.coords.map((c) => c[1]);
  const pad = 0.012;
  status('Ищу мосты, провода, плотины…');
  try {
    const els = await loadObstacles([Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]);
    if (my !== findSeq) return;
    objects = locateObjects(route, els).filter((o) => !(o.k === 'tributary' && nkey(o.name) === nkey(riverName())));
    const pd = wps.map((w) => w.fromStart);
    objects.forEach((o) => {
      const before = pd.filter((d) => d <= o.d).at(-1) ?? 0;
      o.fromPrev = o.d - before;
    });
    objects.forEach((o, i) => { o.fromObj = i ? o.d - objects[i - 1].d : o.d; });
    renderObjects();
    status(`Найдено объектов: ${objects.length}.`);
    save();
  } catch (e) { status('Ошибка поиска объектов: ' + e.message); }
}

const riverName = () => wps[0]?.river || '';

let objMarkers = [];
function renderObjects() {
  objMarkers.forEach((m) => m.remove());
  objMarkers = [];
  if ($('showObjs').checked) {
    objects.forEach((o, i) => {
      const el = document.createElement('div');
      el.className = 'ob';
      el.innerHTML = `о${i + 1}<span>${fmtKm(o.d)}<br>+${fmtKm(o.fromPrev)}</span>`;
      el.addEventListener('click', (e) => e.stopPropagation());
      const mk = new maplibregl.Marker({ element: el }).setLngLat(o.lonlat).addTo(map);
      mk.setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(
        `<b>о${i + 1} ${o.icon} ${o.type}</b>${o.name ? '<br>' + o.name : ''}<br>${fmtKm(o.d)} от старта<br>+${fmtKm(o.fromPrev)} от прошлой точки<br>+${fmtKm(o.fromObj)} от прошлого объекта`));
      objMarkers.push(mk);
    });
  }
  $('objs').innerHTML = (riverName() ? `<tr><td colspan="5"><b>🏞 Река: ${riverName()}</b></tr>` : '') + '<tr><th>№<th>Объект<th>От старта<th>От точки<th>От объекта</tr>' +
    objects.map((o, i) => `<tr><td>о${i + 1}<td>${o.icon} ${o.type}${o.name ? ' «' + o.name + '»' : ''}<td>${fmtKm(o.d)}<td>${fmtKm(o.fromPrev)}<td>${fmtKm(o.fromObj)}`).join('');
}
$('showObjs').onchange = renderObjects;

// ---- уровень воды (данные allrivers.info раз в сутки)
let levels = null, levelsFor = '';
async function updateLevels() {
  const box = $('lvlbox');
  const f = wps[0];
  const k = f ? f.lonlat.join() + '|' + riverName() : '';
  if (k === levelsFor) return;
  levelsFor = k;
  if (!f) { box.innerHTML = ''; gauge = null; return; }
  try { levels ??= await fetch(import.meta.env.BASE_URL + 'data/levels.json').then((r) => r.json()); }
  catch { box.textContent = 'Данные об уровне воды пока недоступны.'; return; }
  const near = levels.gauges.map((g) => ({ g, d: haversine(f.lonlat, [g.lon, g.lat]) })).sort((a, b) => a.d - b.d);
  const same = near.filter((x) => riverName() && nkey(x.g.river) === nkey(riverName()) && x.d < 60000);
  const pick = (same.length ? same : near.filter((x) => x.d < 25000)).slice(0, 2);
  gauge = pick[0]?.g || null;
  const when = new Date(levels.updated).toLocaleDateString('ru-RU');
  box.innerHTML = pick.length
    ? pick.map(({ g, d }) => `<div class="lv"><b>${g.place}</b> (р. ${g.river}, ${fmtKm(d)} от старта)<br>` +
        `${g.level != null ? `<span class="big">${g.level} см</span>${g.delta != null ? ` (${g.delta > 0 ? '+' : ''}${g.delta})` : ''}` : 'уровень не указан'}` +
        `${g.temp != null ? ` · вода ${g.temp}°C` : ''}<br><small>измерено ${g.date || '—'} · <a href="${g.url}" target="_blank">на allrivers.info</a></small></div>`).join('') +
      `<small>Данные обновляются раз в сутки (последний сбор ${when}).</small>`
    : 'Рядом с первой точкой нет гидропоста allrivers.info (в радиусе 25 км).';
}
let gauge = null;

$('undo').onclick = () => {
  const w = wps.pop(); if (!w) return;
  w.marker.remove(); legs.pop(); refresh();
};
function clearAll() {
  wps.forEach((w) => w.marker.remove()); wps = []; legs = []; refresh();
}
$('clear').onclick = clearAll;
$('pdf').onclick = async () => {
  if (!route) return status('Поставьте минимум две точки.');
  status('Готовлю PDF…');
  try {
    await exportPdf({ map, scale: $('pdfScale').value, step: status, name: $('name').value, river: riverName(), points: wps.map((w) => ({ lonlat: w.lonlat, fromStart: w.fromStart, fromPrev: w.fromPrev })), route, objects });
    status('PDF сохранён.');
  } catch (e) { status('Ошибка PDF: ' + e.message); console.error(e); }
};

// сохранение в браузере (localStorage)
function save() {
  localStorage.setItem('rm-route', JSON.stringify({ name: $('name').value, pts: wps.map((w) => w.lonlat), objects }));
}
$('name').oninput = save;
async function loadPoints(pts) {
  clearAll();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60, animate: false, maxZoom: 15 });
  await ensureRivers([Math.min(...xs) - 0.03, Math.min(...ys) - 0.03, Math.max(...xs) + 0.03, Math.max(...ys) + 0.03]);
  for (const p of pts) await addPoint(p);
}

async function restore() {
  try {
    const s = JSON.parse(localStorage.getItem('rm-route') || 'null');
    if (!s?.pts?.length) return;
    $('name').value = s.name;
    await loadPoints(s.pts);
  } catch (e) { console.warn(e); }
}

// ---- сохранённые маршруты
const store = () => JSON.parse(localStorage.getItem('rm-routes') || '{}');
function fillSaved() {
  $('saved').innerHTML = '<option value="">— сохранённые маршруты —</option>' +
    Object.keys(store()).map((n) => `<option>${n.replace(/</g, '&lt;')}</option>`).join('');
}
fillSaved();
$('save').onclick = () => {
  if (!wps.length) return status('Сначала поставьте точки.');
  const all = store();
  all[$('name').value || 'Маршрут'] = { pts: wps.map((w) => w.lonlat), savedAt: Date.now() };
  localStorage.setItem('rm-routes', JSON.stringify(all));
  fillSaved(); $('saved').value = $('name').value;
  status('Маршрут сохранён на этом телефоне.');
};
$('saved').onchange = async () => {
  const n = $('saved').value, r = store()[n];
  if (!r) return;
  $('name').value = n;
  await loadPoints(r.pts);
};
$('del').onclick = () => {
  const n = $('saved').value; if (!n) return;
  const all = store(); delete all[n];
  localStorage.setItem('rm-routes', JSON.stringify(all)); fillSaved(); status('Удалён.');
};
$('gpx').onclick = () => {
  if (!route) return status('Поставьте минимум две точки.');
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const wpt = (p, n) => `<wpt lat="${p[1]}" lon="${p[0]}"><name>${esc(n)}</name></wpt>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="rivermeter" xmlns="http://www.topografix.com/GPX/1/1">` +
    wps.map((w, i) => wpt(w.lonlat, `Точка ${i + 1} (${fmtKm(w.fromStart)})`)).join('') +
    objects.map((o) => wpt(o.lonlat, `${o.type} ${o.name} (${fmtKm(o.d)})`)).join('') +
    `<trk><name>${esc($('name').value)}</name><trkseg>${route.coords.map((c) => `<trkpt lat="${c[1]}" lon="${c[0]}"/>`).join('')}</trkseg></trk></gpx>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
  a.download = ($('name').value || 'marshrut') + '.gpx'; a.click();
};

// ---- «Где я»: положение по GPS относительно плана
let watchId = null, me = null;
$('where').onclick = () => {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId); watchId = null; me?.remove(); me = null;
    $('me').style.display = 'none'; $('where').classList.remove('on'); return;
  }
  if (!navigator.geolocation) return status('GPS недоступен в этом браузере.');
  $('where').classList.add('on');
  let first = true;
  watchId = navigator.geolocation.watchPosition((pos) => {
    const p = [pos.coords.longitude, pos.coords.latitude];
    if (!me) { const el = document.createElement('div'); el.className = 'me'; me = new maplibregl.Marker({ element: el }).setLngLat(p).addTo(map); }
    me.setLngLat(p);
    if (first) { first = false; map.easeTo({ center: p, zoom: Math.max(map.getZoom(), 14) }); }
    showWhere(p, pos.coords.accuracy);
  }, (e) => status('GPS: ' + e.message), { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
};

function showWhere(p, acc) {
  const box = $('me');
  box.style.display = 'block';
  if (!route) { box.textContent = `Вы здесь (±${Math.round(acc)} м). Маршрут не построен.`; return; }
  let best = null;
  for (let i = 1; i < route.coords.length; i++) {
    const r = projectOnSegment(p, route.coords[i - 1], route.coords[i]);
    if (!best || r.dist < best.dist) best = { ...r, d: route.cum[i - 1] + r.t * (route.cum[i] - route.cum[i - 1]) };
  }
  const total = route.cum.at(-1);
  const next = objects.find((o) => o.d > best.d + 5);
  box.innerHTML = best.dist > 300
    ? `Вы в ${fmtKm(best.dist)} от маршрута (±${Math.round(acc)} м)`
    : `<b>Пройдено ${fmtKm(best.d)}</b> · осталось ${fmtKm(total - best.d)}<br>от русла ${Math.round(best.dist)} м (±${Math.round(acc)} м)` +
      (next ? `<br>Дальше: ${next.icon} ${next.type} через ${fmtKm(next.d - best.d)}` : '');
}

window.addEventListener('error', (e) => status('Ошибка: ' + e.message));
window.addEventListener('unhandledrejection', (e) => status('Ошибка: ' + (e.reason?.message || e.reason)));

// ---- кнопки-ссылки
const open = (url) => window.open(url, '_blank');
$('yt').onclick = () => {
  if (!riverName()) return status('Поставьте первую точку на реке.');
  open('https://www.youtube.com/results?search_query=' + encodeURIComponent('обзор реки ' + riverName()));
};
$('ya').onclick = () => {
  if (wps.length < 2) return status('Нужны минимум две точки.');
  const a = wps[0].lonlat, b = wps.at(-1).lonlat;
  open(`https://yandex.ru/maps/?rtext=~${a[1]},${a[0]}~${b[1]},${b[0]}&rtt=auto`);
};
let wm = null;
$('wm').onclick = async () => {
  const r = riverName();
  if (!r) return status('Поставьте первую точку на реке.');
  wm ??= await fetch(import.meta.env.BASE_URL + 'data/wmbel.json').then((x) => x.json()).catch(() => ({}));
  const slug = Object.entries(wm).find(([n]) => nkey(n) === nkey(r))?.[1];
  open(slug ? 'https://wmbel.by/index.php/marshruty/' + slug : 'https://wmbel.by/index.php/component/search/?searchword=' + encodeURIComponent(r));
};
$('lvl').onclick = () => open(gauge ? gauge.url : 'https://allrivers.info/region/belarus');

// ---- поиск реки: исток / середина / устье
let rivers = null;
async function loadNames() {
  if (rivers) return rivers;
  const list = await fetch(import.meta.env.BASE_URL + 'data/names.json').then((x) => x.json());
  rivers = list.map((r) => {
    const ru = r.r || toRu(r.n);
    return { ...r, ru, keys: [nkey(ru), nkey(r.n), nkey(r.b)].filter(Boolean) };
  });
  return rivers;
}
$('q').oninput = async () => {
  const q = nkey($('q').value);
  const box = $('found');
  if (q.length < 2) { box.innerHTML = ''; return; }
  const all = await loadNames();
  const hit = [];
  for (const r of all) {
    const sc = r.keys.some((k) => k.startsWith(q)) ? 0 : r.keys.some((k) => k.includes(q)) ? 1 : 9;
    if (sc < 9) hit.push([sc, r]);
  }
  hit.sort((a, b) => a[0] - b[0] || b[1].l - a[1].l);
  const top = hit.filter(([, r]) => r.l >= 3 || r.keys.includes(q)).slice(0, 6);
  box.innerHTML = top.map(([, r], i) => {
    const alt = r.b && r.b !== r.ru ? ` (${r.b})` : r.n !== r.ru ? ` (${r.n})` : '';
    return `<div class="res"><b>${r.ru}</b>${alt} · ${r.l} км
      <div class="row"><button data-i="${i}" data-p="s">Исток</button><button data-i="${i}" data-p="m">Середина</button><button data-i="${i}" data-p="e">Устье</button></div></div>`;
  }).join('') || '<div class="res">Ничего не найдено</div>';
  box.onclick = (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const r = top[+b.dataset.i][1];
    map.flyTo({ center: r[b.dataset.p], zoom: 14 });
  };
};

window.rm = { map, addPoint, graph };

$('ins').onclick = () => {
  if (wps.length < 2) return status('Для вставки нужны минимум две точки.');
  setInsert(!insertMode);
};
$('keep2').onclick = () => {
  if (wps.length <= 2) return status('Промежуточных точек нет.');
  if (!confirm('Удалить все промежуточные точки? Останутся старт, финиш и объекты на пути.')) return;
  const old = wps.slice();
  const mid = wps.slice(1, -1);
  wps = [wps[0], wps.at(-1)];
  if (!rebuildLegs()) { wps = old; rebuildLegs(); return status('Не удалось: нет пути по реке.'); }
  mid.forEach((w) => w.marker.remove());
  refresh();
};
const syncZoomClass = () => map.getContainer().classList.toggle('zl', map.getZoom() >= 12.5);
map.on('zoom', syncZoomClass);
syncZoomClass();
