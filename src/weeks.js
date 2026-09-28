// Semanas ISO 8601 (lunes a domingo). "CW39" = semana 39 del año.

function pad(n) {
  return String(n).padStart(2, '0');
}

function toYmd(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// Semana ISO de una fecha "AAAA-MM-DD" → { year, week }
function isoWeek(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day); // jueves de esa semana
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil(((date - yearStart) / 86400000 + 1) / 7) };
}

// Número de semanas ISO del año (52 o 53).
function weeksInYear(year) {
  return isoWeek(`${year}-12-28`).week;
}

// Lunes y domingo de la semana → { start: 'AAAA-MM-DD', end: 'AAAA-MM-DD' }
function weekRange(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: toYmd(monday), end: toYmd(sunday) };
}

function weekLabel(week) {
  return `CW${pad(week)}`;
}

module.exports = { isoWeek, weeksInYear, weekRange, weekLabel };
