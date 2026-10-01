// Tarifas del cotizador. Los valores por defecto son una PROPUESTA inicial;
// el administrador los ajusta en el panel → Empresa → Tarifas.
//
// Fórmula: precio = base + max(0, km − km_incluidos) × tarifa_por_km
// (km por carretera desde el centro de Querétaro hasta el destino, solo ida;
//  la tarifa por km ya considera el regreso de la unidad).
// No incluye casetas, maniobras, esperas ni viáticos. Los impuestos se
// calculan aparte según el tipo de cliente (ver `taxes` y taxBreakdown()).

const DEFAULT_PRICING = {
  origin: 'Centro de Querétaro',
  // Punto de salida de las unidades (para calcular rutas con Google).
  base_location: { lat: 20.5926, lng: -100.3924 },
  included_km: 40,
  round_to: 50,
  // Viáticos del chofer (hotel y alimentos) cuando el viaje obliga a pernoctar:
  // una noche por cada `overnight_km` km de distancia (solo ida).
  // Ej.: Monterrey (~690 km) → 1 noche.
  overnight_km: 450,
  overnight_cost: 1500,
  services: [
    {
      id: 'flete',
      label: 'Flete',
      vehicles: [
        { id: 'van', label: 'Van de carga', note: 'Carga ligera y paquetería', base: 1500, per_km: 23 },
        { id: 't35', label: 'Camioneta 3.5 toneladas', note: 'Sujeto a disponibilidad', base: 1500, per_km: 31 },
        { id: 'grande', label: 'Unidad grande (rabón / tórton)', note: 'Cotización especial según carga', special: true },
      ],
    },
    {
      id: 'ejecutivo',
      label: 'Viaje ejecutivo',
      vehicles: [
        { id: 'traverse', label: 'Chevrolet Traverse', note: 'Hasta 6 pasajeros', base: 1500, per_km: 20 },
        { id: 'sienna', label: 'Toyota Sienna', note: 'Hasta 7 pasajeros', base: 1500, per_km: 20 },
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
  ],
  // Impuestos (porcentajes sobre el subtotal). Reglas por tipo de cliente:
  // - Persona moral: IVA 16%; retiene 4% de IVA en autotransporte de bienes
  //   (art. 1-A fr. II inciso c LIVA, solo fletes) y 1.25% de ISR cuando el
  //   transportista es persona física en RESICO (art. 113-J LISR).
  // - Persona física: IVA 16%, sin retenciones.
  // Confírmalo con tu contador; se puede ajustar en el panel.
  taxes: {
    iva: 16,
    ret_iva: 4,
    ret_isr: 1.25,
    rules: {
      fisica: { iva: true, ret_iva: false, ret_isr: false },
      moral: { iva: true, ret_iva: true, ret_isr: true },
    },
    ret_iva_services: ['flete'], // la retención de 4% es solo para transporte de bienes
  },
  payment_methods: ['Efectivo', 'Transferencia', 'Tarjeta de crédito o débito (terminal Mercado Pago)'],
  // En México no se puede cobrar un recargo por pagar con tarjeta (Profeco).
  // Lo permitido: un PRECIO DE LISTA igual para cualquier forma de pago y un
  // DESCUENTO para quien paga en efectivo o transferencia. Las tarifas de arriba
  // son el precio con descuento; el precio de lista se calcula para que el
  // descuento cubra la comisión de la terminal. 0 = sin descuento.
  cash_discount: 4,
  cash_methods: ['Efectivo', 'Transferencia'],
};

const round2 = (n) => Math.round(n * 100) / 100;

// Desglose de impuestos: subtotal → IVA → retenciones → total a pagar.
function taxBreakdown(pricing, { subtotal, clientType, service }) {
  const t = pricing.taxes;
  const rule = t.rules[clientType] || t.rules.fisica;
  const lines = [];
  if (rule.iva) lines.push({ key: 'iva', label: `IVA ${t.iva}%`, amount: round2((subtotal * t.iva) / 100) });
  // Las retenciones (info) las entera el cliente al SAT: se muestran, pero no
  // cambian lo que se cobra. Total cobrado = importe + IVA.
  if (rule.ret_iva && t.ret_iva_services.includes(service)) {
    lines.push({ key: 'ret_iva', label: `Retención de IVA ${t.ret_iva}%`, amount: -round2((subtotal * t.ret_iva) / 100), info: true });
  }
  if (rule.ret_isr) lines.push({ key: 'ret_isr', label: `Retención de ISR ${t.ret_isr}%`, amount: -round2((subtotal * t.ret_isr) / 100), info: true });
  const total = round2(subtotal + lines.filter((l) => !l.info).reduce((sum, l) => sum + l.amount, 0));
  const withheld = round2(-lines.filter((l) => l.info).reduce((sum, l) => sum + l.amount, 0));
  return { subtotal, lines, total, withheld };
}

function estimate(pricing, { vehicle, km }) {
  const v = pricing.services.flatMap((s) => s.vehicles).find((x) => x.id === vehicle);
  if (!v || v.special || !Number.isFinite(km) || km < 0) return null;
  const extraKm = Math.max(0, km - pricing.included_km);
  const raw = v.base + extraKm * v.per_km;
  const step = pricing.round_to || 1;
  const nights = overnightNights(pricing, km);
  const viaticos = nights * (pricing.overnight_cost || 0);
  const total = Math.round(raw / step) * step + viaticos;
  return { total, list: listPrice(pricing, total), base: v.base, extra_km: extraKm, per_km: v.per_km, nights, viaticos };
}

// Ruta con origen y destino elegidos por el cliente: la unidad sale de la base,
// va al origen, luego al destino y regresa. Se cobra la mitad del recorrido
// total como "km equivalentes de ida", igual que un viaje que sale de la base.
// (Si el origen es la base: (0 + d + d) / 2 = d.)
function routeKm({ baseToOrigin, originToDest, destToBase }) {
  return Math.round((baseToOrigin + originToDest + destToBase) / 2);
}

function overnightNights(pricing, km) {
  return pricing.overnight_km > 0 ? Math.floor(km / pricing.overnight_km) : 0;
}

// Precio de lista a partir del precio con descuento (efectivo/transferencia).
function listPrice(pricing, cashPrice) {
  const d = (pricing.cash_discount || 0) / 100;
  if (!d) return cashPrice;
  // Se redondea hacia arriba a $10 para que el descuento no quede por debajo de la comisión.
  return Math.ceil(cashPrice / (1 - d) / 10) * 10;
}

// Mezcla lo guardado por el administrador con los valores por defecto,
// conservando solo números válidos.
function mergePricing(saved, { keepDisabled = false } = {}) {
  const p = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  if (!saved || typeof saved !== 'object') return p;
  const pos = (n, fallback) => (Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : fallback);
  p.included_km = pos(saved.included_km, p.included_km);
  if (saved.overnight_km !== undefined) p.overnight_km = pos(saved.overnight_km, p.overnight_km);
  if (saved.overnight_cost !== undefined) p.overnight_cost = pos(saved.overnight_cost, p.overnight_cost);
  if (saved.cash_discount !== undefined) p.cash_discount = Math.min(20, pos(saved.cash_discount, p.cash_discount));
  if (saved.taxes && typeof saved.taxes === 'object') {
    for (const k of ['iva', 'ret_iva', 'ret_isr']) p.taxes[k] = pos(saved.taxes[k], p.taxes[k]);
    for (const who of ['fisica', 'moral']) {
      for (const k of ['iva', 'ret_iva', 'ret_isr']) {
        if (typeof saved.taxes.rules?.[who]?.[k] === 'boolean') p.taxes.rules[who][k] = saved.taxes.rules[who][k];
      }
    }
  }
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

module.exports = { DEFAULT_PRICING, estimate, listPrice, overnightNights, routeKm, mergePricing, taxBreakdown };
