import * as maplibregl from 'maplibre-gl';
import { RiverGraph } from './graph.js';
import { loadRivers, loadObstacles, locateObjects } from './overpass.js';
import { baseStyle, exportPdf } from './pdf.js';
import { fmtKm, haversine } from './geo.js';

const $ = (id) => document.getElementById(id);
const graph = new RiverGraph();
const loaded = []; // уже загруженные bbox [w,s,e,n]
let wps = [];      // {id, lonlat, marker}
let legs = [];     // {coords, length}
let route = null;  // {coords, cum}
let objects = [];
let seq = 0;

const map = new maplibregl.Map({ container: 'map', style: baseStyle, center: [27.56, 53.9], zoom: 11 });
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
  map.addSource('objs', { type: 'geojson', data: empty });
  map.addLayer({ id: 'objs', type: 'circle', source: 'objs', paint: { 'circle-color': '#e65100', 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
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
  ways.forEach((w) => graph.addWay(w.id, w.coords));
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
  await ensureRivers([p[0] - 0.03, p[1] - 0.02, p[0] + 0.03, p[1] + 0.02]).catch((err) => status('Ошибка загрузки рек: ' + err.message));
  await addPoint(p);
});

// радиус притягивания: 40 px экрана в метрах
function snapRadius() {
  const mpp = (156543.03 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
  return Math.max(30, 40 * mpp);
}

async function addPoint(p) {
  const s = graph.snap(p, snapRadius());
  if (!s) return status('Рядом с кликом нет реки в загруженных данных. Кликните ближе к синей линии реки.');
  const prev = wps.at(-1);
  if (prev) {
    const leg = graph.path(prev.id, s.id);
    if (!leg) return status('Между точками нет пути по реке (разные водотоки или разрыв в данных).');
    legs.push(leg);
  }
  wps.push({ id: s.id, lonlat: s.point, marker: makeMarker(s.point) });
  refresh();
}

function makeMarker(lonlat) {
  const el = document.createElement('div');
  el.className = 'wp';
  const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lonlat).addTo(map);
  m.on('dragend', () => {
    const i = wps.findIndex((w) => w.marker === m);
    const ll = m.getLngLat();
    const s = graph.snap([ll.lng, ll.lat], snapRadius());
    if (!s) { m.setLngLat(wps[i].lonlat); return; }
    const old = wps[i];
    wps[i] = { ...old, id: s.id, lonlat: s.point };
    if (!rebuildLegs()) { wps[i] = old; rebuildLegs(); m.setLngLat(old.lonlat); status('Нет пути по реке для этой точки.'); return; }
    m.setLngLat(s.point);
    refresh();
  });
  return m;
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
  map.getSource('route').setData(route ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } } : empty);

  wps.forEach((w, i) => {
    w.fromStart = pointDist[i] ?? 0;
    w.fromPrev = i ? w.fromStart - pointDist[i - 1] : 0;
    const el = w.marker.getElement();
    el.innerHTML = `${i + 1}<span>${fmtKm(w.fromStart)}${i ? `<br>+${fmtKm(w.fromPrev)}` : ''}</span>`;
  });
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
  const pad = 0.002;
  status('Ищу мосты, провода, плотины…');
  try {
    const els = await loadObstacles([Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]);
    if (my !== findSeq) return;
    objects = locateObjects(route, els);
    const pd = wps.map((w) => w.fromStart);
    objects.forEach((o) => {
      const before = pd.filter((d) => d <= o.d).at(-1) ?? 0;
      o.fromPrev = o.d - before;
    });
    renderObjects();
    status(`Найдено объектов: ${objects.length}.`);
    save();
  } catch (e) { status('Ошибка поиска объектов: ' + e.message); }
}

function renderObjects() {
  map.getSource('objs').setData({
    type: 'FeatureCollection',
    features: objects.map((o) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: o.lonlat } })),
  });
  $('objs').innerHTML = '<tr><th>№<th>Объект<th>От старта<th>От точки</tr>' +
    objects.map((o, i) => `<tr><td>о${i + 1}<td>${o.icon} ${o.type}${o.name ? ' «' + o.name + '»' : ''}<td>${fmtKm(o.d)}<td>${fmtKm(o.fromPrev)}`).join('');
}

$('undo').onclick = () => {
  const w = wps.pop(); if (!w) return;
  w.marker.remove(); legs.pop(); refresh();
};
$('clear').onclick = () => {
  wps.forEach((w) => w.marker.remove()); wps = []; legs = []; refresh();
};
$('pdf').onclick = async () => {
  if (!route) return status('Поставьте минимум две точки.');
  status('Готовлю PDF…');
  try {
    await exportPdf({ name: $('name').value, points: wps.map((w) => ({ lonlat: w.lonlat, fromStart: w.fromStart, fromPrev: w.fromPrev })), route, objects });
    status('PDF сохранён.');
  } catch (e) { status('Ошибка PDF: ' + e.message); console.error(e); }
};

// сохранение в браузере (localStorage)
function save() {
  localStorage.setItem('rm-route', JSON.stringify({ name: $('name').value, pts: wps.map((w) => w.lonlat), objects }));
}
$('name').oninput = save;
async function restore() {
  try {
    const s = JSON.parse(localStorage.getItem('rm-route') || 'null');
    if (!s?.pts?.length) return;
    $('name').value = s.name;
    map.jumpTo({ center: s.pts[0], zoom: 13 });
    const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
    await ensureRivers([Math.min(...xs) - 0.03, Math.min(...ys) - 0.03, Math.max(...xs) + 0.03, Math.max(...ys) + 0.03]);
    for (const p of s.pts) await addPoint(p);
  } catch (e) { console.warn(e); }
}
