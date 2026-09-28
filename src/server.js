const path = require('node:path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const api = require('./api');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(auth.loadUser);
app.use('/api', api);

// Página pública de la empresa (se arma con los datos del panel → Empresa).
const fs = require('node:fs');
const site = require('./site');
const homeTemplate = fs.readFileSync(path.join(__dirname, 'views', 'home.html'), 'utf8');
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function renderHome() {
  const s = site.publicSite();
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const wa = digits(s.whatsapp);
  const values = {
    ...s,
    appUrl: config.appUrl,
    year: new Date().getFullYear(),
    description: s.about ? s.about.slice(0, 160) : `${s.name}: ${s.tagline}. Solicita tu cotización de flete.`,
    phoneHref: s.phone ? `+${digits(s.phone).length === 10 ? `52${digits(s.phone)}` : digits(s.phone)}` : '',
    whatsappUrl: wa ? `https://wa.me/${wa.length === 10 ? `52${wa}` : wa}` : '',
  };
  return homeTemplate
    .replace(/<!--if:(\w+)-->([\s\S]*?)<!--endif:\1-->/g, (_, key, block) => (values[key] ? block : ''))
    .replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(values[key]));
}
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderHome());
});

app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    extensions: ['html'],
    setHeaders(res, file) {
      // El service worker y las páginas siempre se revisan para recibir actualizaciones.
      if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

auth.purgeExpiredSessions();
setInterval(auth.purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`${require('./site').getSite().name} lista en ${config.appUrl} (puerto ${config.port})`);
    if (!config.smtp.host) console.log('Aviso: SMTP no configurado, los correos solo se mostrarán en esta consola.');
    if (!config.googleMapsApiKey) console.log('Aviso: GOOGLE_MAPS_API_KEY no configurada, el mapa para elegir puntos estará desactivado.');
  });
}

module.exports = app;
