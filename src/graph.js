import { haversine, projectOnSegment } from './geo.js';

const key = (p) => p[0].toFixed(6) + ',' + p[1].toFixed(6);

class Heap {
  constructor() { this.a = []; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        let l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

export class RiverGraph {
  constructor() {
    this.nodes = new Map(); // id -> [lon,lat]
    this.adj = new Map();   // id -> Map(id -> dist)
    this.byKey = new Map();
    this.ways = new Map();  // wayId -> [ids]
    this.meta = new Map();  // wayId -> {n, ru}
    this.virtual = 0;
  }
  node(p) {
    const k = key(p);
    let id = this.byKey.get(k);
    if (id === undefined) {
      id = this.nodes.size;
      this.nodes.set(id, p);
      this.adj.set(id, new Map());
      this.byKey.set(k, id);
    }
    return id;
  }
  link(a, b) {
    if (a === b) return;
    const d = haversine(this.nodes.get(a), this.nodes.get(b));
    this.adj.get(a).set(b, d);
    this.adj.get(b).set(a, d);
  }
  addWay(wayId, coords, meta) {
    if (this.ways.has(wayId)) return false;
    if (meta) this.meta.set(wayId, meta);
    const ids = coords.map((c) => this.node(c));
    for (let i = 1; i < ids.length; i++) this.link(ids[i - 1], ids[i]);
    this.ways.set(wayId, ids);
    return true;
  }
  // ближайшая точка реки; вставляет её в граф как новый узел
  snap(p, maxMeters = 400) {
    let best = null;
    for (const [wid, ids] of this.ways) {
      for (let i = 1; i < ids.length; i++) {
        const a = this.nodes.get(ids[i - 1]), b = this.nodes.get(ids[i]);
        const r = projectOnSegment(p, a, b);
        if (!best || r.dist < best.dist) best = { ...r, a: ids[i - 1], b: ids[i], wid };
      }
    }
    if (!best || best.dist > maxMeters) return null;
    const id = this.node(best.point);
    if (id !== best.a && id !== best.b) {
      this.link(best.a, id);
      this.link(id, best.b);
    }
    return { id, point: this.nodes.get(id), meta: this.meta.get(best.wid) };
  }
  // Дейкстра; возвращает {coords, length} или null
  path(from, to) {
    if (from === to) return { coords: [this.nodes.get(from)], length: 0 };
    const dist = new Map([[from, 0]]), prev = new Map();
    const h = new Heap(); h.push(0, from);
    while (h.size) {
      const [d, u] = h.pop();
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (u === to) break;
      for (const [v, w] of this.adj.get(u)) {
        const nd = d + w;
        if (nd < (dist.get(v) ?? Infinity)) {
          dist.set(v, nd); prev.set(v, u); h.push(nd, v);
        }
      }
    }
    if (!dist.has(to)) return null;
    const ids = [to];
    while (ids[0] !== from) ids.unshift(prev.get(ids[0]));
    return { coords: ids.map((i) => this.nodes.get(i)), length: dist.get(to) };
  }
}
