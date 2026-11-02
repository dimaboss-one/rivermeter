// Белорусские названия → русские и ключ для нечёткого поиска
const VOW = 'аеёиіоуыэюя';
const isV = (c) => c && VOW.includes(c.toLowerCase());
const cap = (from, to) => (from === from.toUpperCase() && from !== from.toLowerCase() ? to.toUpperCase() : to);

export function toRu(s) {
  if (!s) return '';
  let out = '';
  const str = s.replace(/[’'`ʼ]/g, '');
  for (let i = 0; i < str.length; i++) {
    const c = str[i], l = c.toLowerCase(), nx = (str[i + 1] || '').toLowerCase(), pv = str[i - 1];
    if (l === 'ў') out += cap(c, 'в');
    else if (l === 'і') out += cap(c, 'и');
    else if (l === 'ш' && nx === 'ч') { out += cap(c, 'щ'); i++; }
    else if (l === 'д' && nx === 'з' && !(isV(str[i + 2]) && false)) { out += cap(c, 'д'); i++; }
    else if (l === 'э' && pv && /[а-яёіў]/i.test(pv)) out += cap(c, 'е');
    else if (l === 'я' && pv && !isV(pv) && /[а-яёіў]/i.test(pv) && str[i + 1] && !isV(str[i + 1]) && /[а-яёіў]/i.test(str[i + 1])) out += cap(c, 'е');
    else out += c;
  }
  return out;
}

export function nkey(s) {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/[’'`ʼьъ]/g, '').replace(/[\s\-–—.,()]+/g, '')
    .replace(/ў/g, 'в').replace(/щ|шч/g, 'ш').replace(/дз/g, 'д').replace(/й/g, 'и')
    .replace(/[ао]/g, 'о').replace(/[еёиыіэя]/g, 'и').replace(/[уюу]/g, 'у')
    .replace(/(.)\1+/g, '$1');
}

export const riverRu = (m) => (m ? m.ru || toRu(m.n) : '');
