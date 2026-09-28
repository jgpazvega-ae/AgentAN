// Configuración por variables de entorno. Ver .env.example para la lista completa.
const fs = require('node:fs');
const path = require('node:path');

// Carga opcional de un archivo .env en la raíz del proyecto (sin dependencias).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  port: Number(env.PORT) || 3000,
  // URL pública de la página, se usa en los enlaces de los correos.
  appUrl: (env.APP_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  companyName: env.COMPANY_NAME || 'AN Mobility Group',
  // Valores iniciales de los datos de la empresa (luego se editan en el panel → Empresa).
  companyRfc: env.COMPANY_RFC || '',
  companyAddress: env.COMPANY_ADDRESS || '',
  companyPhone: env.COMPANY_PHONE || '',
  timezone: env.TZ_DISPLAY || 'America/Mexico_City',
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },
  vapid: {
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  // Detrás de un proxy HTTPS (Render, Railway, Nginx...) activa cookies seguras.
  secureCookies: env.SECURE_COOKIES === 'true' || (env.APP_URL || '').startsWith('https://'),
  sessionDays: Number(env.SESSION_DAYS) || 60,
};
