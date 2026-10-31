import { segIntersect, projectOnSegment, haversine } from './geo.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(q) {
  let err;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q) });
      if (r.ok) return await r.json();
      err = new Error('Overpass ' + r.status);
    } catch (e) { err = e; }
  }
  throw err;
}

const bb = ([w, s, e, n]) => `${s},${w},${n},${e}`;

export async function loadRivers(bounds) {
  const q = `[out:json][timeout:60];way["waterway"~"^(river|stream|canal|drain|ditch)$"]["tunnel"!="culvert"](${bb(bounds)});out geom;`;
  const j = await overpass(q);
  return j.elements
    .filter((e) => e.geometry)
    .map((e) => ({ id: e.id, name: e.tags?.name, coords: e.geometry.map((g) => [g.lon, g.lat]) }));
}

const WW = '^(dam|weir|lock_gate|waterfall|rapids)$';

export async function loadObstacles(bounds) {
  const b = bb(bounds);
  const q = `[out:json][timeout:90];(
way["bridge"]["highway"](${b});
way["bridge"]["railway"](${b});
way["man_made"="bridge"](${b});
way["power"~"^(line|minor_line|cable)$"](${b});
way["waterway"~"${WW}"](${b});
node["waterway"~"${WW}"](${b});
node["ford"="yes"](${b});
way["ford"="yes"](${b});
);out geom;`;
  return (await overpass(q)).elements;
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
    const meta = classify(el.tags);
    const name = el.tags?.name || el.tags?.ref || '';
    if (el.type === 'node') {
      const p = [el.lon, el.lat];
      let best = null;
      for (const i of grid.get(Math.floor(p[0] / CELL) + ':' + Math.floor(p[1] / CELL)) || []) {
        const r = projectOnSegment(p, coords[i - 1], coords[i]);
        if (r.dist < 40 && (!best || r.dist < best.dist))
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
  // слить дубли одного объекта (<30 м) и близкие одноимённые
  found.sort((a, b) => a.d - b.d);
  const out = [];
  for (const f of found) {
    const prev = out.find((o) => o.id === f.id && Math.abs(o.d - f.d) < 30);
    if (!prev) out.push(f);
  }
  return out.map((o) => {
    const p = pointAt(route, o.d);
    return { ...o, lonlat: p };
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
