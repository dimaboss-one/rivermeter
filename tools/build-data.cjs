// Готовит статические данные по Беларуси из выгрузки OSM (Geofabrik):
// реки по тайлам 0.25° и объекты (мосты, ЛЭП, плотины...) в местах пересечения с реками.
// Запуск: NODE_PATH=~/osm-tools/node_modules node --max-old-space-size=6000 tools/build-data.cjs belarus.osm.pbf public/data
const fs = require('fs');
const path = require('path');
const parser = require('osm-pbf-parser');
const { Writable } = require('stream');

const [, , PBF, OUT] = process.argv;
const T = 0.25;
const WW_OBST = new Set(['dam', 'weir', 'lock_gate', 'waterfall', 'rapids']);

function scan(onItems) {
  return new Promise((res, rej) => {
    fs.createReadStream(PBF).pipe(parser())
      .pipe(new Writable({ objectMode: true, write(items, _e, next) { onItems(items); next(); } }))
      .on('finish', res).on('error', rej);
  });
}

function classify(t) {
  if (t.power) return ['power', 'Провода (ЛЭП)'];
  if (t.waterway === 'dam') return ['dam', 'Плотина'];
  if (t.waterway === 'weir') return ['weir', 'Запруда / водослив'];
  if (t.waterway === 'lock_gate') return ['lock', 'Шлюз'];
  if (t.waterway === 'waterfall') return ['waterfall', 'Водопад'];
  if (t.waterway === 'rapids') return ['rapids', 'Пороги'];
  if (t.ford) return ['ford', 'Брод'];
  if (t.railway) return ['rail', 'Ж/д мост'];
  if (t.highway) {
    const small = ['footway', 'path', 'cycleway', 'pedestrian', 'track', 'steps'].includes(t.highway);
    return small ? ['footbridge', 'Мостик (пешеходный)'] : ['bridge', 'Мост (дорога)'];
  }
  return ['bridge', 'Мост'];
}

(async () => {
  const rivers = [], obst = [], obstNodes = [];
  const need = new Set();
  console.log('проход 1: линии');
  await scan((items) => {
    for (const it of items) {
      if (it.type === 'node') {
        const t = it.tags;
        if (t && (WW_OBST.has(t.waterway) || t.ford === 'yes')) obstNodes.push({ id: it.id, lon: it.lon, lat: it.lat, tags: t });
        continue;
      }
      if (it.type !== 'way' || !it.tags) continue;
      const t = it.tags;
      let kind = null;
      if (['river', 'stream', 'canal'].includes(t.waterway) && !t.tunnel) kind = 'river';
      else if (WW_OBST.has(t.waterway) || t.ford === 'yes' || t.man_made === 'bridge' ||
        (t.bridge && t.bridge !== 'no' && (t.highway || t.railway)) || ['line', 'minor_line', 'cable'].includes(t.power)) kind = 'obst';
      if (!kind) continue;
      it.refs.forEach((r) => need.add(r));
      (kind === 'river' ? rivers : obst).push({ id: it.id, tags: t, refs: it.refs });
    }
  });
  console.log('рек', rivers.length, 'препятствий-линий', obst.length, 'узлов', need.size);

  console.log('проход 2: координаты');
  const xy = new Map();
  await scan((items) => {
    for (const it of items) if (it.type === 'node' && need.has(it.id)) xy.set(it.id, [it.lon, it.lat]);
  });
  const geom = (w) => w.refs.map((r) => xy.get(r)).filter(Boolean);

  // тайлы рек
  const key = (x, y) => Math.floor(x / T) + '_' + Math.floor(y / T);
  const riverTiles = new Map();
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const riverGeoms = [];
  for (const w of rivers) {
    const g = geom(w);
    if (g.length < 2) continue;
    riverGeoms.push(g);
    const xs = g.map((p) => p[0]), ys = g.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs) / T), x1 = Math.floor(Math.max(...xs) / T);
    const y0 = Math.floor(Math.min(...ys) / T), y1 = Math.floor(Math.max(...ys) / T);
    const rec = { id: w.id, n: w.tags.name || undefined, c: g.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]) };
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) add(riverTiles, x + '_' + y, rec);
  }

  // пересечения реки × препятствия через сетку
  const CELL = 0.002;
  const grid = new Map();
  riverGeoms.forEach((g, gi) => {
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i];
      for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++)
          add(grid, x + ':' + y, [a, b]);
    }
  });
  const kx = Math.cos((53.5 * Math.PI) / 180);
  const inter = (a, b, c, d) => {
    const r = [(b[0] - a[0]) * kx, b[1] - a[1]], s = [(d[0] - c[0]) * kx, d[1] - c[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-14) return null;
    const q = [(c[0] - a[0]) * kx, c[1] - a[1]];
    const t = (q[0] * s[1] - q[1] * s[0]) / den, u = (q[0] * r[1] - q[1] * r[0]) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  };
  const objTiles = new Map();
  const seen = [];
  let count = 0;
  for (const w of obst) {
    const g = geom(w);
    const [type, label] = classify(w.tags);
    const name = w.tags.name || w.tags.ref || undefined;
    const found = [];
    for (let k = 1; k < g.length; k++) {
      const c = g[k - 1], d = g[k];
      const done = new Set();
      for (let x = Math.floor(Math.min(c[0], d[0]) / CELL); x <= Math.floor(Math.max(c[0], d[0]) / CELL); x++)
        for (let y = Math.floor(Math.min(c[1], d[1]) / CELL); y <= Math.floor(Math.max(c[1], d[1]) / CELL); y++)
          for (const seg of grid.get(x + ':' + y) || []) {
            if (done.has(seg)) continue;
            done.add(seg);
            const t = inter(seg[0], seg[1], c, d);
            if (t === null) continue;
            const p = [seg[0][0] + (seg[1][0] - seg[0][0]) * t, seg[0][1] + (seg[1][1] - seg[0][1]) * t];
            if (!found.some((f) => Math.hypot((f[0] - p[0]) * kx, f[1] - p[1]) < 0.0004)) found.push(p);
          }
    }
    for (const p of found) {
      add(objTiles, key(p[0], p[1]), { id: w.id, k: type, t: label, n: name, x: +p[0].toFixed(5), y: +p[1].toFixed(5) });
      count++;
    }
  }
  // точечные объекты: берём те, что рядом (<40 м) с рекой
  for (const n of obstNodes) {
    const near = [];
    const cx = Math.floor(n.lon / CELL), cy = Math.floor(n.lat / CELL);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) near.push(...(grid.get(x + ':' + y) || []));
    const ok = near.some(([a, b]) => {
      const dx = (b[0] - a[0]) * kx, dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-12;
      let t = (((n.lon - a[0]) * kx) * dx + (n.lat - a[1]) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot((n.lon - a[0]) * kx - dx * t, n.lat - a[1] - dy * t) < 0.00045;
    });
    if (!ok) continue;
    const [type, label] = classify(n.tags);
    add(objTiles, key(n.lon, n.lat), { id: n.id, k: type, t: label, n: n.tags.name || undefined, x: +n.lon.toFixed(5), y: +n.lat.toFixed(5) });
    count++;
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'rivers'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'objs'), { recursive: true });
  const index = { tile: T, rivers: [...riverTiles.keys()], objs: [...objTiles.keys()] };
  for (const [k, v] of riverTiles) fs.writeFileSync(path.join(OUT, 'rivers', k + '.json'), JSON.stringify(v));
  for (const [k, v] of objTiles) fs.writeFileSync(path.join(OUT, 'objs', k + '.json'), JSON.stringify(v));
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  console.log('готово: тайлов рек', riverTiles.size, 'объектов', count);
})();
