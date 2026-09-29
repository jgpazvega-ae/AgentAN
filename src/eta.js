// Tiempo estimado de llegada (ETA).
// - route_minutes: tiempo de manejo del punto de inicio al destino. Lo calcula
//   el panel con Google Maps (Routes API) y el personal lo puede ajustar.
//   Sin Google Maps, se estima aquí con la distancia en línea recta.
// - ETA planeado = fecha y hora de inicio + tiempo de manejo.
// - ETA en ruta = hora real de salida al destino + tiempo de manejo.
// Todas las fechas son hora local "AAAA-MM-DDTHH:MM" (zona de la empresa).

const ROAD_FACTOR = 1.3; // la carretera es ~30 % más larga que la línea recta
const AVG_KMH = 65; // velocidad promedio de una unidad de carga en carretera

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Estimación sin Google Maps: { km, minutes } o null si faltan coordenadas.
function roughRoute(from, to) {
  if ([from?.lat, from?.lng, to?.lat, to?.lng].some((v) => v == null)) return null;
  const km = Math.round(haversineKm(from, to) * ROAD_FACTOR);
  return { km, minutes: Math.max(10, Math.round((km / AVG_KMH) * 60)) };
}

// "2026-10-01T08:30" + 90 min → "2026-10-01T10:00"
function addMinutes(local, minutes) {
  if (!local || minutes == null) return null;
  const [date, time = '00:00'] = String(local).split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + Math.round(minutes) * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

function durationText(minutes) {
  if (minutes == null) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

// Minutos entre dos horas locales "AAAA-MM-DDTHH:MM".
function minutesBetween(a, b) {
  const parse = (v) => {
    const [date, time = '00:00'] = String(v).split('T');
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return Date.UTC(y, m - 1, d, hh, mm);
  };
  return Math.round((parse(b) - parse(a)) / 60000);
}

// Agrega eta_at (planeado), eta_live_at (ya en ruta) y eta (el vigente).
// Las pausas después de salir al destino (hotel, descanso) recorren el ETA:
// - pausa terminada: se suma lo que duró;
// - pausa en curso: ETA = hora planeada para reanudar + manejo que falta
//   (si el chofer no indicó cuándo reanuda, el ETA queda sin calcular).
function withEta(trip) {
  if (!trip) return trip;
  const minutes = trip.route_minutes;
  const pauses = trip.pauses || [];
  const open = pauses.find((p) => !p.resumed_at) || null;
  trip.paused = Boolean(open);
  trip.pause_until = open ? open.resume_planned_at || null : null;
  trip.eta_at = addMinutes(trip.pickup_at, minutes);
  trip.eta_live_at = null;
  if (trip.departed_at && minutes != null) {
    const onRoad = pauses.filter((p) => p.paused_at >= trip.departed_at);
    const pausedMin = onRoad.filter((p) => p.resumed_at).reduce((sum, p) => sum + Math.max(0, minutesBetween(p.paused_at, p.resumed_at)), 0);
    const current = onRoad.find((p) => !p.resumed_at);
    if (current) {
      const driven = minutesBetween(trip.departed_at, current.paused_at) - pausedMin;
      trip.eta_live_at = current.resume_planned_at ? addMinutes(current.resume_planned_at, Math.max(0, minutes - driven)) : null;
    } else {
      trip.eta_live_at = addMinutes(trip.departed_at, minutes + pausedMin);
    }
  }
  const arrived = ['en_destino', 'entregado', 'finalizado', 'cancelado'].includes(trip.status);
  trip.eta = arrived ? null : trip.departed_at ? trip.eta_live_at : trip.eta_at;
  return trip;
}

module.exports = { roughRoute, addMinutes, minutesBetween, durationText, withEta, haversineKm };
