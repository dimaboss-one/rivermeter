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

// снимок основной карты: вписываем маршрут, ждём тайлы, возвращаем вид обратно
async function snapshot(map, route, objects, points) {
  const view = { center: map.getCenter(), zoom: map.getZoom() };
  const xs = route.coords.map((c) => c[0]), ys = route.coords.map((c) => c[1]);
  map.setLayoutProperty('rivers', 'visibility', 'none');
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 50, animate: false, maxZoom: 16 });
  await waitIdle(map, 10000);
  const src = map.getCanvas();
  const k = src.width / src.clientWidth;
  const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(src, 0, 0);
  objects.forEach((o, i) => { const p = map.project(o.lonlat); marker(ctx, [p.x * k, p.y * k], 'о' + (i + 1), '#e65100', 11 * k); });
  points.forEach((pt, i) => { const p = map.project(pt.lonlat); marker(ctx, [p.x * k, p.y * k], String(i + 1), '#6a1b9a', 13 * k); });
  const img = cv.toDataURL('image/jpeg', 0.88);
  map.setLayoutProperty('rivers', 'visibility', 'visible');
  map.jumpTo(view);
  return { img, w: cv.width, h: cv.height };
}

function marker(ctx, [x, y], text, fill, r = 14) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
  ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `bold ${r + 2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
}

export async function exportPdf({ map, river, name, points, route, objects, step = () => {} }) {
  step('Снимаю карту…');
  const { img, w, h } = await snapshot(map, route, objects, points);
  step('Загружаю шрифт…');
  const font = await (await fetch(import.meta.env.BASE_URL + 'DejaVuSans.ttf')).arrayBuffer();
  const b64 = btoa(binary(font));
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.addFileToVFS('DejaVuSans.ttf', b64);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu');

  doc.setFontSize(15); doc.text((name || 'Маршрут') + (river ? ' — р. ' + river : ''), 10, 14);
  doc.setFontSize(9);
  doc.text(`Длина: ${fmtKm(route.cum.at(-1))}   Точек: ${points.length}   Объектов: ${objects.length}   ${new Date().toLocaleDateString('ru-RU')}`, 10, 20);
  const mw = Math.min(190, (175 * w) / h), mh = (mw * h) / w;
  doc.addImage(img, 'JPEG', 10, 24, mw, mh);
  doc.setFontSize(7); doc.text('Карта: © OpenStreetMap. Длина по оси реки из OSM, точность ±2–5%.', 10, 24 + mh + 4);

  let y = 24 + mh + 12;
  const table = (title, head, rows, widths) => {
    const line = (cells, bold) => {
      if (y > 280) { doc.addPage(); y = 15; }
      let x = 10;
      cells.forEach((c, i) => { doc.text(String(c), x, y); x += widths[i]; });
      y += 5;
      if (bold) { doc.line(10, y - 3.6, 200, y - 3.6); }
    };
    doc.setFontSize(11);
    if (y > 270) { doc.addPage(); y = 15; }
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
