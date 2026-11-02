import * as maplibregl from 'maplibre-gl';
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

const waitIdle = (map, ms) => new Promise((res) => {
  const t = setTimeout(res, ms);
  map.once('idle', () => { clearTimeout(t); res(); });
  map.triggerRepaint();
});

// снимок основной карты в формате листа A4: карта временно растягивается на нужный размер
async function snapshot(map, route, objects, points, title) {
  const view = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing() };
  const xs = route.coords.map((c) => c[0]), ys = route.coords.map((c) => c[1]);
  const lat0 = (Math.min(...ys) + Math.max(...ys)) / 2;
  const dx = (Math.max(...xs) - Math.min(...xs)) * Math.cos((lat0 * Math.PI) / 180), dy = Math.max(...ys) - Math.min(...ys);
  const land = dx > dy * 1.15;
  const PW = 202, PH = 289; // мм, поля 4 мм
  const W = land ? Math.round((900 * PH) / PW) : 900, H = land ? 900 : Math.round((900 * PH) / PW);
  const el = map.getContainer(), saved = el.style.cssText, ratio = window.devicePixelRatio || 1;
  el.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;z-index:9999;flex:none`;
  map.setPixelRatio(2);
  map.resize();
  map.setLayoutProperty('rivers', 'visibility', 'none');
  map.setPaintProperty('route', 'line-width', 3.5);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 70, animate: false, maxZoom: 15, bearing: 0 });
  await waitIdle(map, 12000);
  await waitIdle(map, 4000);
  const src = map.getCanvas();
  const k = src.width / W;
  const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const placed = [];
  const hit = (r) => placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
  const label = (text, x, y, r, color, size) => {
    ctx.font = `bold ${size * k}px sans-serif`;
    const w = ctx.measureText(text).width, h = size * k * 1.1, g = r + 3 * k;
    const cand = [[g, -g - h / 2], [g, g - h / 2], [-g - w, -g - h / 2], [-g - w, g - h / 2], [-w / 2, -g - h], [-w / 2, g], [g + 6 * k, -h / 2], [-g - w - 6 * k, -h / 2]];
    let best = cand[0];
    for (const c of cand) { if (!hit({ x: x + c[0], y: y + c[1], w, h })) { best = c; break; } }
    const px = x + best[0], py = y + best[1];
    placed.push({ x: px, y: py, w, h });
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.lineWidth = 3.2 * k; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round';
    ctx.strokeText(text, px, py); ctx.fillStyle = color; ctx.fillText(text, px, py);
  };
  const dot = (x, y, r, color, square) => {
    ctx.beginPath();
    if (square) ctx.rect(x - r, y - r, 2 * r, 2 * r); else ctx.arc(x, y, r, 0, 7);
    ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1.6 * k; ctx.strokeStyle = '#fff'; ctx.stroke();
  };
  const pp = points.map((pt) => map.project(pt.lonlat));
  const oo = objects.map((o) => map.project(o.lonlat));
  pp.forEach((p) => placed.push({ x: p.x * k - 6 * k, y: p.y * k - 6 * k, w: 12 * k, h: 12 * k }));
  oo.forEach((p) => placed.push({ x: p.x * k - 4 * k, y: p.y * k - 4 * k, w: 8 * k, h: 8 * k }));
  pp.forEach((p, i) => { dot(p.x * k, p.y * k, 4.5 * k, '#6a1b9a'); label(String(i + 1), p.x * k, p.y * k, 4.5 * k, '#6a1b9a', 15); });
  oo.forEach((p, i) => { dot(p.x * k, p.y * k, 3.2 * k, '#e65100', true); label('о' + (i + 1), p.x * k, p.y * k, 3.2 * k, '#bf360c', 11); });

  // заголовок, масштабная линейка, источник
  ctx.font = `bold ${15 * k}px sans-serif`;
  const tw = ctx.measureText(title).width + 20 * k;
  ctx.fillStyle = '#ffffffe6'; ctx.fillRect(10 * k, 10 * k, tw, 28 * k);
  ctx.fillStyle = '#4a148c'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(title, 20 * k, 24.5 * k);
  const mpp = (78271.517 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
  const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000].reduce((b, v) => (Math.abs(v / mpp - 150) < Math.abs(b / mpp - 150) ? v : b));
  const bw = (nice / mpp) * k, bx = 16 * k, by = H * k - 26 * k;
  ctx.fillStyle = '#ffffffe6'; ctx.fillRect(bx - 6 * k, by - 18 * k, bw + 12 * k, 34 * k);
  ctx.fillStyle = '#000'; ctx.fillRect(bx, by, bw, 3 * k); ctx.fillRect(bx, by - 5 * k, 1.5 * k, 8 * k); ctx.fillRect(bx + bw - 1.5 * k, by - 5 * k, 1.5 * k, 8 * k);
  ctx.font = `${11 * k}px sans-serif`; ctx.textBaseline = 'bottom'; ctx.fillText(nice >= 1000 ? nice / 1000 + ' км' : nice + ' м', bx, by - 7 * k);
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#ffffffe6';
  const cr = '© OpenStreetMap contributors', cw = ctx.measureText(cr).width;
  ctx.fillRect(W * k - cw - 16 * k, H * k - 22 * k, cw + 12 * k, 18 * k);
  ctx.fillStyle = '#333'; ctx.fillText(cr, W * k - 10 * k, H * k - 7 * k);

  const img = cv.toDataURL('image/jpeg', 0.86);

  el.style.cssText = saved;
  map.setPixelRatio(ratio);
  map.resize();
  map.setLayoutProperty('rivers', 'visibility', 'visible');
  map.setPaintProperty('route', 'line-width', 5);
  map.jumpTo(view);
  return { img, land, PW, PH };
}

export async function exportPdf({ map, river, name, points, route, objects, step = () => {} }) {
  step('Снимаю карту для печати…');
  const title = `${name || 'Маршрут'}${river ? ' — р. ' + river : ''} · ${fmtKm(route.cum.at(-1))}`;
  const { img, land, PW, PH } = await snapshot(map, route, objects, points, title);
  step('Загружаю шрифт…');
  const font = await (await fetch(import.meta.env.BASE_URL + 'DejaVuSans.ttf')).arrayBuffer();
  const b64 = btoa(binary(font));
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: land ? 'l' : 'p' });
  doc.addFileToVFS('DejaVuSans.ttf', b64);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu');

  // страница 1: карта на весь лист
  if (land) doc.addImage(img, 'JPEG', 4, 4, PH, PW); else doc.addImage(img, 'JPEG', 4, 4, PW, PH);

  // страница 2+: таблицы
  doc.addPage('a4', 'p');
  doc.setFontSize(15); doc.text((name || 'Маршрут') + (river ? ' — р. ' + river : ''), 10, 14);
  doc.setFontSize(9);
  doc.text(`Длина: ${fmtKm(route.cum.at(-1))}   Точек: ${points.length}   Объектов: ${objects.length}   ${new Date().toLocaleDateString('ru-RU')}`, 10, 20);
  doc.setFontSize(7); doc.text('Карта: © OpenStreetMap. Длина по оси реки из OSM, точность ±2–5%. Номера точек и объектов (о1, о2…) как на карте.', 10, 25);

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
  table('Реестр объектов на пути', ['№', 'Объект', 'От старта', 'От прошлой точки', 'Название'],
    objects.map((o, i) => ['о' + (i + 1), o.type, fmtKm(o.d), fmtKm(o.fromPrev), o.name]), [14, 50, 30, 38, 58]);
  step('Сохраняю файл…');
  doc.save((name || 'marshrut') + '.pdf');
}

function binary(buf) {
  const a = new Uint8Array(buf); let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return s;
}
