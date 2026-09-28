// Utilidades compartidas por las rutas de la API.
const config = require('./config');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);

// Envuelve rutas para que los errores lleguen al manejador central.
const h = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

function str(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}
function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Fecha y hora actual en la zona horaria de la empresa: "AAAA-MM-DDTHH:MM".
function nowLocal() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

module.exports = { HttpError, bad, h, str, num, nowLocal };
