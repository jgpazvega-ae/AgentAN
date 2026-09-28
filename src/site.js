// Datos de la empresa que se muestran en la página pública, correos y recibos.
// Se editan desde el panel (pestaña "Empresa"); las variables de entorno solo
// sirven como valores iniciales.
const config = require('./config');
const { getSetting, setSetting } = require('./db');
const { mergePricing } = require('./pricing');

const FIELDS = {
  name: 100,
  tagline: 200,
  about: 2000,
  service_area: 300,
  phone: 40,
  whatsapp: 40,
  email: 200,
  address: 300,
  rfc: 20,
  quotes_email: 200, // a dónde llegan las solicitudes de cotización
};

function defaults() {
  return {
    name: config.companyName,
    tagline: 'Transporte de carga puntual y seguro',
    about: '',
    service_area: '',
    phone: config.companyPhone,
    whatsapp: '',
    email: '',
    address: config.companyAddress,
    rfc: config.companyRfc,
    quotes_email: '',
  };
}

let cache = null;
function getSite() {
  if (!cache) {
    let saved = {};
    try {
      saved = JSON.parse(getSetting('site') || '{}');
    } catch {}
    cache = { ...defaults(), ...saved };
  }
  return cache;
}

function updateSite(input) {
  const next = { ...getSite() };
  for (const [key, max] of Object.entries(FIELDS)) {
    if (input[key] === undefined) continue;
    next[key] = String(input[key] ?? '').trim().slice(0, max);
  }
  if (!next.name) next.name = config.companyName;
  setSetting('site', JSON.stringify(next));
  cache = next;
  return next;
}

// Solo lo que puede ver cualquier visitante.
function publicSite() {
  const { quotes_email, ...rest } = getSite();
  return rest;
}

// ---------- Tarifas del cotizador ----------
function savedPricing() {
  try {
    return JSON.parse(getSetting('pricing') || 'null');
  } catch {
    return null;
  }
}

function getPricing(opts) {
  return mergePricing(savedPricing(), opts);
}

// input: { included_km, vehicles: { van: { base, per_km, enabled }, ... } }
function updatePricing(input) {
  const saved = savedPricing() || {};
  const next = {
    included_km: input.included_km ?? saved.included_km,
    vehicles: { ...(saved.vehicles || {}) },
    taxes: input.taxes || saved.taxes,
    cash_discount: input.cash_discount ?? saved.cash_discount,
    overnight_km: input.overnight_km ?? saved.overnight_km,
    overnight_cost: input.overnight_cost ?? saved.overnight_cost,
  };
  for (const [id, v] of Object.entries(input.vehicles || {})) {
    next.vehicles[id] = { base: Number(v.base), per_km: Number(v.per_km), enabled: v.enabled !== false };
  }
  setSetting('pricing', JSON.stringify(next));
  return getPricing();
}

module.exports = { getSite, updateSite, publicSite, getPricing, updatePricing };
