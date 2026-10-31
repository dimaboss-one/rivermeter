const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// локальная плоская проекция (метры) вокруг широты lat0
export function toXY(p, lat0) {
  return [rad(p[0]) * R * Math.cos(rad(lat0)), rad(p[1]) * R];
}

// проекция точки p на отрезок ab (в координатах [lon,lat]); возвращает {t, point, dist}
export function projectOnSegment(p, a, b) {
  const lat0 = p[1];
  const P = toXY(p, lat0), A = toXY(a, lat0), B = toXY(b, lat0);
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const X = [A[0] + dx * t, A[1] + dy * t];
  return { t, point, dist: Math.hypot(P[0] - X[0], P[1] - X[1]) };
}

// пересечение отрезков ab и cd; возвращает t по ab или null
export function segIntersect(a, b, c, d) {
  const lat0 = a[1];
  const A = toXY(a, lat0), B = toXY(b, lat0), C = toXY(c, lat0), D = toXY(d, lat0);
  const r = [B[0] - A[0], B[1] - A[1]];
  const s = [D[0] - C[0], D[1] - C[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const qp = [C[0] - A[0], C[1] - A[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

export const fmtKm = (m) => (m / 1000).toFixed(2).replace('.', ',') + ' км';
