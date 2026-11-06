// Arma la página pública de la empresa a partir de la plantilla views/home.html.
// No depende de la base de datos para poder usarse también al generar la
// versión estática para GitHub Pages (scripts/build-pages.js).
const fs = require('node:fs');
const path = require('node:path');

const template = fs.readFileSync(path.join(__dirname, 'views', 'home.html'), 'utf8');

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const digits = (v) => String(v || '').replace(/\D/g, '');
// Números de 10 dígitos se toman como mexicanos (+52).
const intl = (v) => (digits(v).length === 10 ? `52${digits(v)}` : digits(v));

// Escapa HTML y también las llaves, para que un texto con "{{algo}}" no se confunda con la plantilla.
const safe = (v) => escapeHtml(v).replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'));

// Empresas con las que se ha trabajado: una por renglón (máximo 24).
function clientsHtml(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 24)
    .map((name) => `<li>${safe(name)}</li>`)
    .join('');
}

// Opiniones: "Comentario | Nombre y puesto | Empresa" por renglón (máximo 6).
function testimonialsHtml(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.split('|').map((p) => p.trim()))
    .filter(([quote]) => quote)
    .slice(0, 6)
    .map(([quote, who, company]) => {
      const by = [who, company].filter(Boolean).map((p) => p.slice(0, 100)).join(' · ');
      return `<figure class="quote"><blockquote>${safe(quote.slice(0, 400))}</blockquote>${by ? `<figcaption>${safe(by)}</figcaption>` : ''}</figure>`;
    })
    .join('');
}

// site: datos públicos de la empresa; pricing: tarifas del cotizador;
// opts.static: versión sin servidor (GitHub Pages); opts.loginUrl: enlace de "Iniciar sesión";
// opts.mapsKey: llave de Google Maps para que el cliente elija origen y destino.
function renderHome(site, pricing, opts = {}) {
  const wa = intl(site.whatsapp);
  const values = {
    ...site,
    appUrl: opts.appUrl || '',
    loginUrl: opts.loginUrl || '/login.html',
    originLabel: pricing.origin,
    year: new Date().getFullYear(),
    description: site.about ? site.about.slice(0, 160) : `${site.name}: ${site.tagline}. Fletes y viajes ejecutivos desde Querétaro. Cotiza en línea.`,
    phoneHref: site.phone ? `+${intl(site.phone)}` : '',
    whatsappUrl: wa ? `https://wa.me/${wa}` : '',
    clientsHtml: clientsHtml(site.clients),
    testimonialsHtml: testimonialsHtml(site.testimonials),
    // JSON dentro de <script>: se escapa "<" para que no pueda cerrar la etiqueta.
    pageData: JSON.stringify({
      pricing: { ...pricing, cities: [...pricing.cities].sort((a, b) => a.km - b.km) },
      static: Boolean(opts.static),
      mapsKey: opts.mapsKey || '',
      whatsapp: wa,
      email: site.email || '',
    }).replace(/</g, '\\u003c'),
  };
  return template
    .replace(/<!--if:(\w+)-->([\s\S]*?)<!--endif:\1-->/g, (_, key, block) => (values[key] ? block : ''))
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, key) => values[key])
    .replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(values[key]));
}

module.exports = { renderHome };
