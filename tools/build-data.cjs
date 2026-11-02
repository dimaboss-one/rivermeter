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

const isCamp = (t) => t.tourism === 'camp_site' || t.tourism === 'camp_pitch' || t.leisure === 'firepit' || t.tourism === 'picnic_site';
const placeLabel = (t) => t.landuse === 'allotments' || t.place === 'allotments' ? 'Дачи / садовое товарищество' : { city: 'Город', town: 'Город / посёлок', village: 'Деревня', hamlet: 'Хутор / деревушка' }[t.place] || 'Населённый пункт';
const campLabel = (t) => t.tourism === 'camp_site' ? 'Кемпинг / стоянка' : t.tourism === 'camp_pitch' ? 'Место под палатку' : t.leisure === 'firepit' ? 'Кострище' : 'Место отдыха (пикник)';

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
  const rivers = [], obst = [], obstNodes = [], campPts = [], campWays = [], placeNodes = [], placeWays = [];
  const need = new Set();
  console.log('проход 1: линии');
  await scan((items) => {
    for (const it of items) {
      if (it.type === 'node') {
        const t = it.tags;
        if (t && (WW_OBST.has(t.waterway) || t.ford === 'yes')) obstNodes.push({ id: it.id, lon: it.lon, lat: it.lat, tags: t });
        if (t && isCamp(t)) campPts.push({ id: it.id, lon: it.lon, lat: it.lat, tags: t });
        if (t && t.name && ['city', 'town', 'village', 'hamlet'].includes(t.place)) placeNodes.push({ id: it.id, lon: it.lon, lat: it.lat, tags: t });
        continue;
      }
      if (it.type !== 'way' || !it.tags) continue;
      const t = it.tags;
      if (t.name && (t.landuse === 'allotments' || t.place === 'allotments' || t.place === 'village' || t.place === 'hamlet') && !t.waterway) { it.refs.forEach((r) => need.add(r)); placeWays.push({ id: it.id, tags: t, refs: it.refs }); continue; }
      if (isCamp(t) && !t.waterway) { it.refs.forEach((r) => need.add(r)); campWays.push({ id: it.id, tags: t, refs: it.refs }); continue; }
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
    const rec = { id: w.id, n: w.tags.name || undefined, ru: w.tags['name:ru'] || undefined, be: w.tags['name:be'] || undefined, c: g.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]) };
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


  // ---- притоки: именованная река W заканчивается в узле, через который проходит другая река
  const nm = (w) => w.tags['name:ru'] || w.tags.name;
  const named = rivers.filter((w) => nm(w));
  const ends = new Map();
  named.forEach((w, i) => { const e = w.refs.at(-1); if (!ends.has(e)) ends.set(e, []); ends.get(e).push(i); });
  const through = new Map();
  named.forEach((w, i) => w.refs.forEach((r, pos) => {
    if (!ends.has(r)) return;
    if (!through.has(r)) through.set(r, []);
    through.get(r).push({ i, pos: pos === 0 ? 'start' : pos === w.refs.length - 1 ? 'end' : 'mid' });
  }));
  let trib = 0;
  for (const [node, wayIdxs] of ends) {
    const p = xy.get(node);
    if (!p) continue;
    const others = through.get(node) || [];
    for (const wi of wayIdxs) {
      const W = named[wi];
      const byName = new Map();
      for (const o of others) {
        if (o.i === wi || nm(named[o.i]) === nm(W)) continue;
        const arr = byName.get(nm(named[o.i])) || [];
        arr.push(o.pos); byName.set(nm(named[o.i]), arr);
      }
      for (const [into, poss] of byName) {
        if (!(poss.includes('mid') || (poss.includes('start') && poss.includes('end')))) continue;
        add(objTiles, key(p[0], p[1]), { id: W.id, k: 'tributary', t: 'Впадает приток', n: W.tags.name, ru: W.tags['name:ru'], into, x: +p[0].toFixed(5), y: +p[1].toFixed(5) });
        trib++; count++;
        break;
      }
    }
  }
  console.log('притоков', trib);

  // ---- места для стоянок рядом с рекой (до 250 м)
  const segDist = (px, py, a, b) => {
    const dx = (b[0] - a[0]) * kx, dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-12;
    let t = (((px - a[0]) * kx) * dx + (py - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot((px - a[0]) * kx - dx * t, py - a[1] - dy * t) * 111320;
  };
  const camps = campPts.map((c) => ({ ...c }));
  for (const w of campWays) {
    const g = geom(w);
    if (!g.length) continue;
    camps.push({ id: w.id, lon: g.reduce((a, p) => a + p[0], 0) / g.length, lat: g.reduce((a, p) => a + p[1], 0) / g.length, tags: w.tags });
  }
  let campN = 0;
  for (const c of camps) {
    let best = Infinity;
    const cx = Math.floor(c.lon / CELL), cy = Math.floor(c.lat / CELL);
    for (let x = cx - 2; x <= cx + 2; x++) for (let y = cy - 2; y <= cy + 2; y++)
      for (const [a, b] of grid.get(x + ':' + y) || []) best = Math.min(best, segDist(c.lon, c.lat, a, b));
    if (best > 250) continue;
    add(objTiles, key(c.lon, c.lat), { id: c.id, k: 'camp', t: campLabel(c.tags), n: c.tags.name, m: Math.round(best), x: +c.lon.toFixed(5), y: +c.lat.toFixed(5) });
    campN++; count++;
  }
  console.log('стоянок', campN);

  // ---- населённые пункты и дачи в пределах 1 км от русла; точка — ближайшая к реке
  const near = (px, py, R) => {
    let best = Infinity;
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
    for (let x = cx - R; x <= cx + R; x++) for (let y = cy - R; y <= cy + R; y++)
      for (const [a, b] of grid.get(x + ':' + y) || []) best = Math.min(best, segDist(px, py, a, b));
    return best;
  };
  let vill = 0;
  const addPlace = (id, tags, lon, lat, m) => {
    add(objTiles, key(lon, lat), { id, k: 'village', t: placeLabel(tags), n: tags.name, ru: tags['name:ru'], m: Math.round(m), x: +lon.toFixed(5), y: +lat.toFixed(5) });
    vill++; count++;
  };
  for (const n of placeNodes) { const m = near(n.lon, n.lat, 8); if (m <= 1000) addPlace(n.id, n.tags, n.lon, n.lat, m); }
  for (const w of placeWays) {
    let best = null;
    for (const p of geom(w)) { const m = near(p[0], p[1], 8); if (m <= 1000 && (!best || m < best.m)) best = { m, p }; }
    if (best) addPlace(w.id, w.tags, best.p[0], best.p[1], best.m);
  }
  console.log('населённых пунктов', vill);

  // ---- реестр рек для поиска: исток / середина / устье
  const hav = (a, b) => {
    const R = 6371008.8, r = (d) => (d * Math.PI) / 180;
    const s = Math.sin(r(b[1] - a[1]) / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const groups = new Map();
  named.forEach((w, i) => { const k = nm(w); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const entities = [];
  for (const [gname, idxs] of groups) {
    const parent = new Map(idxs.map((i) => [i, i]));
    const find = (i) => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); } return i; };
    const byNode = new Map();
    for (const i of idxs) for (const r of [named[i].refs[0], named[i].refs.at(-1)]) {
      if (byNode.has(r)) parent.set(find(i), find(byNode.get(r))); else byNode.set(r, i);
    }
    const comps = new Map();
    for (const i of idxs) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); }
    for (const members of comps.values()) {
      const info = members.map((i) => { const g = geom(named[i]); let l = 0; for (let k = 1; k < g.length; k++) l += hav(g[k - 1], g[k]); return { i, g, l }; }).filter((m) => m.g.length > 1);
      const total = info.reduce((a, m) => a + m.l, 0);
      if (total < 1500) continue;
      const lastSet = new Set(info.map((m) => named[m.i].refs.at(-1)));
      const starts = info.filter((m) => !lastSet.has(named[m.i].refs[0])).sort((a, b) => b.l - a.l).slice(0, 5);
      let bestChain = null;
      for (const st of (starts.length ? starts : [info[0]])) {
        const chain = [st], seenW = new Set([st.i]);
        for (;;) {
          const end = named[chain.at(-1).i].refs.at(-1);
          const nxt = info.filter((m) => !seenW.has(m.i) && named[m.i].refs[0] === end).sort((a, b) => b.l - a.l)[0];
          if (!nxt) break;
          chain.push(nxt); seenW.add(nxt.i);
        }
        const len = chain.reduce((a, m) => a + m.l, 0);
        if (!bestChain || len > bestChain.len) bestChain = { chain, len };
      }
      const pts = bestChain.chain.flatMap((m) => m.g);
      let acc = 0, mid = pts[0];
      for (let k = 1; k < pts.length; k++) { acc += hav(pts[k - 1], pts[k]); if (acc >= bestChain.len / 2) { mid = pts[k]; break; } }
      const w0 = named[members[0]].tags;
      const r5 = (p) => [+p[0].toFixed(5), +p[1].toFixed(5)];
      entities.push({ r: w0['name:ru'] || undefined, n: w0.name || gname, b: w0['name:be'] || undefined, l: +(total / 1000).toFixed(1), s: r5(pts[0]), m: r5(mid), e: r5(pts.at(-1)) });
    }
  }
  console.log('рек в поиске', entities.length);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'rivers'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'objs'), { recursive: true });
  const index = { tile: T, rivers: [...riverTiles.keys()], objs: [...objTiles.keys()] };
  for (const [k, v] of riverTiles) fs.writeFileSync(path.join(OUT, 'rivers', k + '.json'), JSON.stringify(v));
  for (const [k, v] of objTiles) fs.writeFileSync(path.join(OUT, 'objs', k + '.json'), JSON.stringify(v));
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(OUT, 'names.json'), JSON.stringify(entities));
  console.log('готово: тайлов рек', riverTiles.size, 'объектов', count);
})();
