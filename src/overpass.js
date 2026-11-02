import { segIntersect, projectOnSegment, haversine } from './geo.js';
import { toRu } from './names.js';

const BASE = import.meta.env.BASE_URL + 'data/';
const cache = new Map();

async function getJson(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : [])).catch((e) => { cache.delete(url); throw e; }));
  }
  return cache.get(url);
}

async function tilesFor(kind, [w, s, e, n]) {
  const idx = await getJson(BASE + 'index.json');
  const T = idx.tile;
  const have = new Set(idx[kind]);
  const out = [];
  for (let x = Math.floor(w / T); x <= Math.floor(e / T); x++)
    for (let y = Math.floor(s / T); y <= Math.floor(n / T); y++)
      if (have.has(x + '_' + y)) out.push(...(await getJson(`${BASE}${kind}/${x}_${y}.json`)));
  return out;
}

export async function loadRivers(bounds) {
  return (await tilesFor('rivers', bounds)).map((r) => ({ id: r.id, name: r.n, ru: r.ru, coords: r.c }));
}

const ICONS = { power: '⚡', dam: '🚧', weir: '🚧', lock: '🚧', waterfall: '🌊', rapids: '🌊', ford: '〰', tributary: '↘️', camp: '⛺' };

export async function loadObstacles(bounds) {
  return (await tilesFor('objs', bounds)).map((o) => {
    let name = o.n || '';
    if (o.k === 'tributary') name = o.ru || toRu(o.n);
    if (o.k === 'camp') name = [o.n, `${o.m} м от русла`].filter(Boolean).join(' · ');
    return {
      type: 'node', id: o.id, lon: o.x, lat: o.y, name, tol: o.k === 'camp' ? 260 : 40,
      meta: { type: o.t, icon: ICONS[o.k] || '🌉', k: o.k },
    };
  });
}

function classify(t = {}) {
  if (t.power) return { type: 'Провода (ЛЭП)', icon: '⚡' };
  if (t.waterway === 'dam') return { type: 'Плотина', icon: '🚧' };
  if (t.waterway === 'weir') return { type: 'Запруда / водослив', icon: '🚧' };
  if (t.waterway === 'lock_gate') return { type: 'Шлюз', icon: '🚧' };
  if (t.waterway === 'waterfall') return { type: 'Водопад', icon: '🌊' };
  if (t.waterway === 'rapids') return { type: 'Пороги', icon: '🌊' };
  if (t.ford) return { type: 'Брод', icon: '〰' };
  if (t.railway) return { type: 'Ж/д мост', icon: '🌉' };
  if (t.highway) {
    const small = ['footway', 'path', 'cycleway', 'pedestrian', 'track'].includes(t.highway);
    return { type: small ? 'Мостик (пешеходный)' : 'Мост (дорога)', icon: '🌉' };
  }
  return { type: 'Мост', icon: '🌉' };
}

const CELL = 0.004;
const cellsOf = (a, b) => {
  const out = [];
  const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
  const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(x + ':' + y);
  return out;
}

// маршрут: coords + накопленные расстояния; возвращает объекты с distance (м от старта)
export function locateObjects(route, elements) {
  const { coords, cum } = route;
  const grid = new Map();
  for (let i = 1; i < coords.length; i++)
    for (const c of cellsOf(coords[i - 1], coords[i])) {
      if (!grid.has(c)) grid.set(c, []);
      grid.get(c).push(i);
    }
  const found = [];
  for (const el of elements) {
    const meta = el.meta || classify(el.tags);
    const name = el.name ?? (el.tags?.name || el.tags?.ref || '');
    if (el.type === 'node') {
      const p = [el.lon, el.lat];
      let best = null;
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      const cand = [];
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) cand.push(...(grid.get(x + ':' + y) || []));
      for (const i of cand) {
        const r = projectOnSegment(p, coords[i - 1], coords[i]);
        if (r.dist < (el.tol ?? 40) && (!best || r.dist < best.dist))
          best = { dist: r.dist, d: cum[i - 1] + r.t * (cum[i] - cum[i - 1]) };
      }
      if (best) found.push({ id: el.id, ...meta, name, d: best.d });
      continue;
    }
    if (!el.geometry) continue;
    const g = el.geometry.map((x) => [x.lon, x.lat]);
    for (let k = 1; k < g.length; k++) {
      const seen = new Set();
      for (const c of cellsOf(g[k - 1], g[k])) {
        for (const i of grid.get(c) || []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const t = segIntersect(coords[i - 1], coords[i], g[k - 1], g[k]);
          if (t !== null) found.push({ id: el.id, ...meta, name, d: cum[i - 1] + t * (cum[i] - cum[i - 1]) });
        }
      }
    }
  }
  return cluster(found).map((o) => ({ ...o, lonlat: pointAt(route, o.d) }));
}

const BRIDGE = new Set(['bridge', 'footbridge', 'rail']);
const group = (k) => (BRIDGE.has(k) ? 'bridge' : k);

// один мост = несколько линий OSM (полосы, тротуары, перила): склеиваем близкие объекты одной группы
function cluster(found) {
  found.sort((a, b) => a.d - b.d);
  const out = [];
  for (const f of found) {
    const g = group(f.k);
    const gap = g === 'bridge' ? 80 : 40;
    const prev = out.findLast((o) => o.group === g && f.d - o.dEnd < gap);
    if (!prev) { out.push({ ...f, group: g, dEnd: f.d, ks: new Set([f.k]), names: new Set(f.name ? [f.name] : []) }); continue; }
    prev.dEnd = f.d; prev.ks.add(f.k); if (f.name) prev.names.add(f.name);
  }
  return out.map((o) => {
    let type = o.type, icon = o.icon;
    if (o.group === 'bridge') {
      icon = '🌉';
      type = o.ks.has('rail') ? 'Ж/д мост' : o.ks.has('bridge') ? 'Мост (дорога)' : o.ks.size && [...o.ks].every((k) => k === 'footbridge') ? 'Мостик (пешеходный)' : 'Мост';
    }
    const name = [...o.names].join(', ');
    return { id: o.id, k: o.group, type, icon, name: name.length > 40 ? name.slice(0, 38) + '…' : name, d: (o.d + o.dEnd) / 2 };
  });
}

export function pointAt({ coords, cum }, d) {
  let i = 1;
  while (i < coords.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
  return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
}

export { haversine };
