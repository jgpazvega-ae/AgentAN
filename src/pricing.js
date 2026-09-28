// Tarifas del cotizador. Los valores por defecto son una PROPUESTA inicial;
// el administrador los ajusta en el panel → Empresa → Tarifas.
//
// Fórmula: precio = base + max(0, km − km_incluidos) × tarifa_por_km
// (km por carretera desde el centro de Querétaro hasta el destino, solo ida;
//  la tarifa por km ya considera el regreso de la unidad).
// No incluye casetas, maniobras, esperas, viáticos ni IVA.

const DEFAULT_PRICING = {
  origin: 'Centro de Querétaro',
  included_km: 40,
  round_to: 50,
  services: [
    {
      id: 'flete',
      label: 'Flete',
      vehicles: [
        { id: 'van', label: 'Van de carga', note: 'Carga ligera y paquetería', base: 1500, per_km: 18 },
        { id: 't35', label: 'Camioneta 3.5 toneladas', note: 'Sujeto a disponibilidad', base: 1500, per_km: 26 },
        { id: 'grande', label: 'Unidad grande (rabón / tórton)', note: 'Cotización especial según carga', special: true },
      ],
    },
    {
      id: 'ejecutivo',
      label: 'Viaje ejecutivo',
      vehicles: [
        { id: 'traverse', label: 'Chevrolet Traverse', note: 'Hasta 6 pasajeros', base: 1500, per_km: 15 },
        { id: 'sienna', label: 'Toyota Sienna', note: 'Hasta 7 pasajeros', base: 1500, per_km: 15 },
      ],
    },
  ],
  // Distancias aproximadas por carretera desde el centro de Querétaro (km, solo ida).
  cities: [
    { name: 'Zona metropolitana de Querétaro', km: 20 },
    { name: 'Celaya', km: 50 },
    { name: 'San Juan del Río', km: 55 },
    { name: 'San Miguel de Allende', km: 65 },
    { name: 'Salamanca', km: 95 },
    { name: 'Irapuato', km: 115 },
    { name: 'Guanajuato', km: 140 },
    { name: 'León', km: 171 },
    { name: 'Morelia', km: 200 },
    { name: 'San Luis Potosí', km: 205 },
    { name: 'Ciudad de México', km: 215 },
    { name: 'Toluca', km: 190 },
    { name: 'Pachuca', km: 220 },
    { name: 'Aguascalientes', km: 295 },
    { name: 'Puebla', km: 335 },
    { name: 'Guadalajara', km: 350 },
    { name: 'Monterrey', km: 690 },
  ],
  extras: [
    'Casetas de ida y vuelta según el tipo de unidad',
    'Maniobras de carga y descarga (ayudantes)',
    'Tiempo de espera mayor a 2 horas',
    'Viáticos del chofer cuando el viaje requiere pernoctar',
    'IVA',
  ],
};

function estimate(pricing, { vehicle, km }) {
  const v = pricing.services.flatMap((s) => s.vehicles).find((x) => x.id === vehicle);
  if (!v || v.special || !Number.isFinite(km) || km < 0) return null;
  const extraKm = Math.max(0, km - pricing.included_km);
  const raw = v.base + extraKm * v.per_km;
  const step = pricing.round_to || 1;
  return { total: Math.round(raw / step) * step, base: v.base, extra_km: extraKm, per_km: v.per_km };
}

// Mezcla lo guardado por el administrador con los valores por defecto,
// conservando solo números válidos.
function mergePricing(saved, { keepDisabled = false } = {}) {
  const p = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  if (!saved || typeof saved !== 'object') return p;
  const pos = (n, fallback) => (Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : fallback);
  p.included_km = pos(saved.included_km, p.included_km);
  for (const s of p.services) {
    for (const v of s.vehicles) {
      const o = saved.vehicles?.[v.id];
      if (!o) continue;
      if (!v.special) {
        v.base = pos(o.base, v.base);
        v.per_km = pos(o.per_km, v.per_km);
      }
      if (o.enabled === false) v.disabled = true;
    }
    if (!keepDisabled) s.vehicles = s.vehicles.filter((v) => !v.disabled);
  }
  if (!keepDisabled) p.services = p.services.filter((s) => s.vehicles.length);
  return p;
}

module.exports = { DEFAULT_PRICING, estimate, mergePricing };
