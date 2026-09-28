// Genera la versión estática de la página de la empresa para GitHub Pages
// (carpeta _site/). No necesita base de datos ni dependencias de npm.
//
//   node scripts/build-pages.js
//
// Datos: pages/sitio.json. Tarifas: las mismas propuestas de src/pricing.js.
// En esta versión el formulario de cotización se envía por WhatsApp o correo,
// porque GitHub Pages no tiene servidor.
const fs = require('node:fs');
const path = require('node:path');
const { renderHome } = require('../src/home');
const { mergePricing } = require('../src/pricing');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
const site = JSON.parse(fs.readFileSync(path.join(root, 'pages', 'sitio.json'), 'utf8'));
delete site._instrucciones;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Si el acceso de choferes ya está publicado en otro dominio, se puede indicar aquí.
const loginUrl = process.env.LOGIN_URL || 'login.html';

let html = renderHome(site, mergePricing(null), { static: true, loginUrl, appUrl: process.env.PAGES_URL || '' });
html = html
  // GitHub Pages publica en /<repositorio>/: se usan rutas relativas.
  .replace(/(href|src)="\/(?!\/)/g, '$1="./')
  // Sin servidor no hay app instalable.
  .replace(/\s*<link rel="manifest"[^>]*>/, '');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'css'), { recursive: true });
fs.mkdirSync(path.join(out, 'js'), { recursive: true });
fs.mkdirSync(path.join(out, 'img'), { recursive: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
const copy = (rel) => fs.copyFileSync(path.join(root, 'public', rel), path.join(out, rel));
['css/site.css', 'js/cotizador.js', 'img/logo.png', 'img/logo-light.png', 'img/logo-mark.png', 'icons/favicon.png', 'icons/apple-touch-icon.png'].forEach(copy);

// Mientras la plataforma no esté publicada, "Iniciar sesión" muestra este aviso.
fs.writeFileSync(
  path.join(out, 'login.html'),
  `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acceso · ${esc(site.name)}</title>
  <link rel="icon" href="./icons/favicon.png" type="image/png">
  <link rel="stylesheet" href="./css/site.css">
</head>
<body style="background:var(--soft)">
  <main class="wrap" style="min-height:100vh;display:grid;place-items:center">
    <div class="card" style="max-width:440px;text-align:center">
      <img src="./img/logo.png" alt="${esc(site.name)}" style="width:240px">
      <h2 style="margin-top:16px">Acceso para choferes y administración</h2>
      <p class="muted-text">La plataforma de viajes estará disponible muy pronto en nuestro dominio.</p>
      <a class="btn btn-accent" href="./">Volver a la página</a>
    </div>
  </main>
</body>
</html>
`
);
console.log(`Página estática generada en ${path.relative(root, out)}/`);
