import { jsPDF } from 'jspdf';
import { fmtKm } from './geo.js';

export const baseStyle = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const PW = 202, PH = 289; // мм: рабочая область A4 (поля 4 мм)
const km2 = (m) => (m / 1000).toFixed(2).replace('.', ',');

const waitIdle = (map, ms) => new Promise((res) => {
  const t = setTimeout(res, ms);
  map.once('idle', () => { clearTimeout(t); res(); });
  map.triggerRepaint();
});

// веб-меркатор в «пикселях» maplibre на заданном зуме (512 px — мир при zoom 0)
const mx = (lon, z) => ((lon + 180) / 360) * 512 * 2 ** z;
const my = (lat, z) => (0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) * 512 * 2 ** z;
const unx = (x, z) => (x / (512 * 2 ** z)) * 360 - 180;
const uny = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (512 * 2 ** z)))) * 180) / Math.PI;

// раскладка листов: сетка с нахлёстом, остаются только листы, через которые идёт маршрут
function planSheets(route, z, W, H) {
  const pts = [];
  route.coords.forEach((c, i) => {
    const p = [mx(c[0], z), my(c[1], z)];
    if (i) { const q = pts.at(-1); pts.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]); }
    pts.push(p);
  });
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  const ov = 70, sx = W - ov, sy = H - ov, m = 30;
  const cols = Math.max(1, Math.ceil((maxX - minX + 2 * m - ov) / sx)), rows = Math.max(1, Math.ceil((maxY - minY + 2 * m - ov) / sy));
  const x0 = (minX + maxX) / 2 - (cols * sx + ov) / 2, y0 = (minY + maxY) / 2 - (rows * sy + ov) / 2;
  const sheets = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const rx = x0 + c * sx, ry = y0 + r * sy;
    const first = pts.findIndex((p) => p[0] > rx + 20 && p[0] < rx + W - 20 && p[1] > ry + 20 && p[1] < ry + H - 20);
    if (first >= 0) sheets.push({ first, center: [unx(rx + W / 2, z), uny(ry + H / 2, z)] });
  }
  return sheets.sort((a, b) => a.first - b.first);
}

function drawLabels(ctx, map, k, { points, objects }, { objText = true, W, H }) {
  const placed = [];
  const hit = (r) => placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
  const inside = (p) => p.x > -20 && p.y > -20 && p.x < W + 20 && p.y < H + 20;
  const fontOf = (i, size) => `bold ${(i ? size - 2.5 : size) * k}px sans-serif`;
  const label = (lines, x, y, r, color, size) => {
    const lh = size * k * 1.15;
    const w = Math.max(...lines.map((t, i) => { ctx.font = fontOf(i, size); return ctx.measureText(t).width; }));
    const h = lh * lines.length, g = r + 3 * k;
    const cand = [[g, -h / 2], [g, -h - g / 2], [g, g / 2], [-g - w, -h / 2], [-g - w, -h - g / 2], [-g - w, g / 2], [-w / 2, -g - h], [-w / 2, g]];
    let best = cand[0];
    for (const c of cand) { if (!hit({ x: x + c[0], y: y + c[1], w, h })) { best = c; break; } }
    const px = x + best[0], py = y + best[1];
    placed.push({ x: px, y: py, w, h });
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
    lines.forEach((t, i) => {
      ctx.font = fontOf(i, size);
      ctx.lineWidth = 3.4 * k; ctx.strokeStyle = '#fff'; ctx.strokeText(t, px, py + i * lh);
      ctx.fillStyle = i ? '#222' : color; ctx.fillText(t, px, py + i * lh);
    });
  };
  const dot = (x, y, r, color, square) => {
    ctx.beginPath();
    if (square) ctx.rect(x - r, y - r, 2 * r, 2 * r); else ctx.arc(x, y, r, 0, 7);
    ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1.6 * k; ctx.strokeStyle = '#fff'; ctx.stroke();
  };
  const pp = points.map((pt) => map.project(pt.lonlat)), oo = objects.map((o) => map.project(o.lonlat));
  pp.forEach((p) => placed.push({ x: p.x * k - 6 * k, y: p.y * k - 6 * k, w: 12 * k, h: 12 * k }));
  oo.forEach((p) => placed.push({ x: p.x * k - 4 * k, y: p.y * k - 4 * k, w: 8 * k, h: 8 * k }));
  pp.forEach((p, i) => {
    if (!inside(p)) return;
    dot(p.x * k, p.y * k, 4.5 * k, '#6a1b9a');
    const pt = points[i];
    label([String(i + 1), `${km2(pt.fromStart)} км` + (i ? ` (+${km2(pt.fromPrev)})` : '')], p.x * k, p.y * k, 4.5 * k, '#6a1b9a', 15);
  });
  oo.forEach((p, i) => {
    if (!inside(p)) return;
    dot(p.x * k, p.y * k, 3.2 * k, '#e65100', true);
    const o = objects[i];
    label(objText ? ['о' + (i + 1), `${km2(o.d)} (+${km2(o.fromPrev)})`] : ['о' + (i + 1)], p.x * k, p.y * k, 3.2 * k, '#bf360c', 11);
  });
}

function drawFrame(ctx, k, W, title, page) {
  ctx.font = `bold ${15 * k}px sans-serif`;
  const tw = ctx.measureText(title).width + 20 * k;
  ctx.fillStyle = '#ffffffe6'; ctx.fillRect(10 * k, 10 * k, tw, 28 * k);
  ctx.fillStyle = '#4a148c'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(title, 20 * k, 24.5 * k);
  if (page) {
    ctx.font = `bold ${13 * k}px sans-serif`;
    const w = ctx.measureText(page).width + 16 * k;
    ctx.fillStyle = '#ffffffe6'; ctx.fillRect(W * k - w - 10 * k, 10 * k, w, 26 * k);
    ctx.fillStyle = '#222'; ctx.textAlign = 'right'; ctx.fillText(page, W * k - 18 * k, 23.5 * k);
  }
}

function drawScale(ctx, map, k, W, H) {
  const mpp = (78271.517 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
  const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000].reduce((b, v) => (Math.abs(v / mpp - 150) < Math.abs(b / mpp - 150) ? v : b));
  const bw = (nice / mpp) * k, bx = 16 * k, by = H * k - 26 * k;
  ctx.fillStyle = '#ffffffe6'; ctx.fillRect(bx - 6 * k, by - 18 * k, bw + 12 * k, 34 * k);
  ctx.fillStyle = '#000'; ctx.fillRect(bx, by, bw, 3 * k); ctx.fillRect(bx, by - 5 * k, 1.5 * k, 8 * k); ctx.fillRect(bx + bw - 1.5 * k, by - 5 * k, 1.5 * k, 8 * k);
  ctx.font = `${11 * k}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(nice >= 1000 ? nice / 1000 + ' км' : nice + ' м', bx, by - 7 * k);
  ctx.textAlign = 'right'; ctx.fillStyle = '#ffffffe6';
  const cr = '© OpenStreetMap contributors', cw = ctx.measureText(cr).width;
  ctx.fillRect(W * k - cw - 16 * k, H * k - 22 * k, cw + 12 * k, 18 * k);
  ctx.fillStyle = '#333'; ctx.fillText(cr, W * k - 10 * k, H * k - 7 * k);
}

// scale: 'overview' (1 лист), 'mid' (zoom 12) или 'detail' (zoom 13) — несколько листов + обзорная схема
async function renderMaps(map, route, objects, points, title, scale, step) {
  const view = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing() };
  const xs = route.coords.map((c) => c[0]), ys = route.coords.map((c) => c[1]);
  const lat0 = (Math.min(...ys) + Math.max(...ys)) / 2;
  const dx = (Math.max(...xs) - Math.min(...xs)) * Math.cos((lat0 * Math.PI) / 180), dy = Math.max(...ys) - Math.min(...ys);
  const land = dx > dy * 1.15;
  const W = land ? Math.round((900 * PH) / PW) : 900, H = land ? 900 : Math.round((900 * PH) / PW);
  const el = map.getContainer(), saved = el.style.cssText, ratio = window.devicePixelRatio || 1;
  const bounds = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  const images = [];
  try {
    el.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;z-index:9999;flex:none`;
    map.setPixelRatio(2);
    map.resize();
    map.setLayoutProperty('rivers', 'visibility', 'none');
    map.setPaintProperty('route', 'line-width', 3.5);
    const k = 2;
    const snap = async (draw) => {
      await waitIdle(map, 12000);
      await waitIdle(map, 3000);
      const src = map.getCanvas();
      const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(src, 0, 0);
      draw(ctx);
      drawScale(ctx, map, k, W, H);
      return cv.toDataURL('image/jpeg', 0.85);
    };
    step('Снимаю обзорную карту…');
    map.fitBounds(bounds, { padding: 70, animate: false, maxZoom: 15, bearing: 0 });
    let sheets = [], z = 0;
    if (scale !== 'overview') {
      z = scale === 'detail' ? 13 : 12;
      sheets = planSheets(route, z, W, H);
      while (sheets.length > 12 && z > 9) { z -= 0.5; sheets = planSheets(route, z, W, H); }
    }
    images.push(await snap((ctx) => {
      if (sheets.length > 1) {
        ctx.lineWidth = 2 * k; ctx.strokeStyle = '#d81b60'; ctx.fillStyle = '#d81b60'; ctx.font = `bold ${16 * k}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        sheets.forEach((s, i) => {
          const cx = mx(s.center[0], z), cy = my(s.center[1], z);
          const a = map.project([unx(cx - W / 2, z), uny(cy - H / 2, z)]), b = map.project([unx(cx + W / 2, z), uny(cy + H / 2, z)]);
          ctx.setLineDash([8 * k, 5 * k]); ctx.strokeRect(a.x * k, a.y * k, (b.x - a.x) * k, (b.y - a.y) * k); ctx.setLineDash([]);
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 3.5 * k; ctx.strokeText('Лист ' + (i + 1), a.x * k + 6 * k, a.y * k + 6 * k);
          ctx.fillText('Лист ' + (i + 1), a.x * k + 6 * k, a.y * k + 6 * k);
          ctx.strokeStyle = '#d81b60'; ctx.lineWidth = 2 * k;
        });
      }
      drawLabels(ctx, map, k, { points, objects }, { objText: sheets.length < 2, W, H });
      drawFrame(ctx, k, W, title, sheets.length > 1 ? 'обзор' : '');
    }));
    if (sheets.length > 1) {
      for (let i = 0; i < sheets.length; i++) {
        step(`Снимаю лист ${i + 1} из ${sheets.length}…`);
        map.jumpTo({ center: sheets[i].center, zoom: z, bearing: 0 });
        images.push(await snap((ctx) => {
          drawLabels(ctx, map, k, { points, objects }, { W, H });
          drawFrame(ctx, k, W, title, `лист ${i + 1} из ${sheets.length}`);
        }));
      }
    }
  } finally {
    el.style.cssText = saved;
    map.setPixelRatio(ratio);
    map.resize();
    map.setLayoutProperty('rivers', 'visibility', 'visible');
    map.setPaintProperty('route', 'line-width', 5);
    map.jumpTo(view);
  }
  return { images, land };
}

export async function exportPdf({ map, river, name, points, route, objects, scale = 'mid', step = () => {} }) {
  const title = `${name || 'Маршрут'}${river ? ' — р. ' + river : ''} · ${fmtKm(route.cum.at(-1))}`;
  const { images, land } = await renderMaps(map, route, objects, points, title, scale, step);
  step('Загружаю шрифт…');
  const font = await (await fetch(import.meta.env.BASE_URL + 'DejaVuSans.ttf')).arrayBuffer();
  const b64 = btoa(binary(font));
  step('Собираю PDF…');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: land ? 'l' : 'p' });
  doc.addFileToVFS('DejaVuSans.ttf', b64);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu');

  images.forEach((img, i) => {
    if (i) doc.addPage('a4', land ? 'l' : 'p');
    if (land) doc.addImage(img, 'JPEG', 4, 4, PH, PW); else doc.addImage(img, 'JPEG', 4, 4, PW, PH);
  });

  doc.addPage('a4', 'p');
  doc.setFontSize(15); doc.text((name || 'Маршрут') + (river ? ' — р. ' + river : ''), 10, 14);
  doc.setFontSize(9);
  doc.text(`Длина: ${fmtKm(route.cum.at(-1))}   Точек: ${points.length}   Объектов: ${objects.length}   ${new Date().toLocaleDateString('ru-RU')}`, 10, 20);
  doc.setFontSize(7); doc.text('Карта: © OpenStreetMap. Длина по оси реки из OSM, точность ±2–5%. На карте: км от старта (+км от прошлой точки).', 10, 25);

  let y = 33;
  const table = (title, head, rows, widths) => {
    const line = (cells, bold) => {
      if (y > 280) { doc.addPage('a4', 'p'); y = 15; }
      let x = 10;
      cells.forEach((c, i) => { doc.text(String(c), x, y); x += widths[i]; });
      y += 5;
      if (bold) { doc.line(10, y - 3.6, 200, y - 3.6); }
    };
    doc.setFontSize(11);
    if (y > 270) { doc.addPage('a4', 'p'); y = 15; }
    doc.text(title, 10, y); y += 6;
    doc.setFontSize(9);
    line(head, true);
    rows.forEach((r) => line(r));
    y += 4;
  };
  table('Точки маршрута', ['№', 'От старта', 'От прошлой точки'],
    points.map((p, i) => [i + 1, fmtKm(p.fromStart), i ? fmtKm(p.fromPrev) : '—']), [15, 45, 60]);
  table('Реестр объектов на пути', ['№', 'Объект', 'От старта', 'От точки', 'От объекта', 'Название'],
    objects.map((o, i) => ['о' + (i + 1), o.type, fmtKm(o.d), fmtKm(o.fromPrev), fmtKm(o.fromObj), o.name]), [12, 44, 24, 24, 24, 62]);
  step('Сохраняю файл…');
  doc.save((name || 'marshrut') + '.pdf');
}

function binary(buf) {
  const a = new Uint8Array(buf); let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return s;
}
