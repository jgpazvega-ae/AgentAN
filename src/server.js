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
const site = require('./site');
const { renderHome } = require('./home');
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderHome(site.publicSite(), site.getPricing(), { appUrl: config.appUrl }));
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
