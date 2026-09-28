// Configuración de PM2 para mantener la app encendida en un VPS (ver README → Neubox).
module.exports = {
  apps: [
    {
      name: 'fletes',
      script: 'src/server.js',
      instances: 1, // SQLite: una sola instancia
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
