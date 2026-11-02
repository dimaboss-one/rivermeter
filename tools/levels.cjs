// Раз в сутки собирает уровни воды по постам Беларуси с allrivers.info (только цифры + ссылка на источник).
// Запуск: node tools/levels.cjs public/data/levels.json
const fs = require('fs');
const BASE = 'https://allrivers.info';
const UA = 'rivermeter-bot/1.0 (+https://github.com/dimaboss-one/rivermeter)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.text();
      if (r.status === 429) {
        const wait = Math.min(120, parseInt(r.headers.get('retry-after') || '0', 10) || 20 * (i + 1));
        console.log('429, жду', wait, 'с');
        await sleep(wait * 1000);
        continue;
      }
    } catch {}
    await sleep(3000 * (i + 1));
  }
  throw new Error('не удалось загрузить ' + url);
}

const num = (s) => (s == null ? null : parseFloat(String(s).replace(',', '.')));

(async () => {
  const out = process.argv[2];
  const region = await get(BASE + '/region/belarus');
  const gauges = new Map();
  const re = /<a href="(\/gauge\/[^"\/]+)">\s*(?:<span[^>]*>\s*([^<]*?),?\s*<\/span>)?\s*([^<]*?)\s*<\/a>/g;
  for (const m of region.matchAll(re)) gauges.set(m[1], { river: (m[2] || '').replace(/^р\.\s*/, '').replace(/,$/, '').trim(), place: m[3].trim() });
  console.log('постов', gauges.size);
  const list = [];
  for (const [path, g] of gauges) {
    try {
      const h = await get(BASE + path);
      const ll = h.match(/:lat="([\d.]+)"\s*:lng="([\d.]+)"/);
      const lv = h.match(/Уровень воды: \([\s\S]*?<div class="dot"><\/div>\s*<div>\s*(-?[\d.,]+)\s*см\s*(?:\(\s*([-+]?[\d.,]+)\s*\))?/);
      const tp = h.match(/Температура воды<\/div>\s*<div class="dot"><\/div>\s*<div>\s*(-?[\d.,]+)/);
      const dt = h.match(/Дата проверки<\/div>\s*<div class="dot"><\/div>\s*<div>\s*([^<]+?)\s*<\/div>/);
      if (!ll) continue;
      list.push({
        url: BASE + path, river: g.river, place: g.place,
        lat: +ll[1], lon: +ll[2],
        level: lv ? num(lv[1]) : null, delta: lv && lv[2] != null ? num(lv[2]) : null,
        temp: tp ? num(tp[1]) : null, date: dt ? dt[1] : null,
      });
    } catch (e) { console.log('пропуск', path, e.message); }
    await sleep(2500);
  }
  fs.writeFileSync(out, JSON.stringify({ updated: new Date().toISOString(), source: BASE, gauges: list }));
  console.log('записано', list.length, 'с уровнем', list.filter((x) => x.level != null).length);
})();
