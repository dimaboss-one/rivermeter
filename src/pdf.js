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

async function renderMap(route, w, h) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:-99999px;top:0;width:${w}px;height:${h}px`;
  document.body.append(el);
  const map = new maplibregl.Map({
    container: el, style: baseStyle, interactive: false, attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true }, pixelRatio: 1,
  });
  await new Promise((r) => map.on('load', r));
  map.addSource('r', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords } } });
  map.addLayer({ id: 'r', type: 'line', source: 'r', paint: { 'line-color': '#8e24aa', 'line-width': 5 }, layout: { 'line-join': 'round' } });
  const xs = route.coords.map((c) => c[0]), ys = route.coords.map((c) => c[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60, animate: false, maxZoom: 16 });
  await new Promise((r) => { const f = () => map.loaded() && map.areTilesLoaded() ? r() : map.once('idle', f); setTimeout(f, 300); });
  return { map, el };
}

function marker(ctx, [x, y], text, fill, r = 14) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
  ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `bold ${r + 2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
}

export async function exportPdf({ name, points, route, objects }) {
  const W = 1140, H = 840;
  const { map, el } = await renderMap(route, W, H);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(map.getCanvas(), 0, 0);
  objects.forEach((o, i) => { const p = map.project(o.lonlat); marker(ctx, [p.x, p.y], 'о' + (i + 1), '#e65100', 12); });
  points.forEach((pt, i) => { const p = map.project(pt.lonlat); marker(ctx, [p.x, p.y], String(i + 1), '#6a1b9a'); });
  const img = cv.toDataURL('image/jpeg', 0.9);
  map.remove(); el.remove();

  const font = await (await fetch(import.meta.env.BASE_URL + 'DejaVuSans.ttf')).arrayBuffer();
  const b64 = btoa(binary(font));
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.addFileToVFS('DejaVuSans.ttf', b64);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu');

  doc.setFontSize(15); doc.text(name || 'Маршрут', 10, 14);
  doc.setFontSize(9);
  doc.text(`Длина: ${fmtKm(route.cum.at(-1))}   Точек: ${points.length}   Объектов: ${objects.length}   ${new Date().toLocaleDateString('ru-RU')}`, 10, 20);
  doc.addImage(img, 'JPEG', 10, 24, 190, 190 * H / W);
  doc.setFontSize(7); doc.text('Карта: © OpenStreetMap. Длина по оси реки из OSM, точность ±2–5%.', 10, 24 + 190 * H / W + 4);

  let y = 24 + 190 * H / W + 12;
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
  doc.save((name || 'marshrut') + '.pdf');
}

function binary(buf) {
  const a = new Uint8Array(buf); let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return s;
}
