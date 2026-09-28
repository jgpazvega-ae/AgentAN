# Fletes · Plataforma de viajes para choferes

Página web que se instala en el celular como una app (PWA). Sirve para que el chofer:

- **Inicie sesión y vea sus viajes asignados** (pendientes e historial).
- **Reciba avisos al instante** cuando se le asigna, cambia o cancela un viaje: **notificación push** (como Uber) y **correo electrónico**.
- **Navegue con Google Maps** a la recolección y al destino con un toque.
- **Inicie y finalice el viaje desde la página** tomando **foto del odómetro** al inicio y al final.
- Registre **cargas de combustible** (litros, importe y foto del ticket) y envíe **notas** a la oficina.

Y para que el administrador:

- Dé de alta **choferes** y **vehículos** (sin límite; la base está lista para crecer).
- **Cree viajes** eligiendo el punto de recolección y el destino **en el mapa o buscándolos**, con fecha y hora de recolección y entrega (opcional).
- Vea el avance de cada viaje, las fotos, la ubicación desde donde el chofer marcó cada paso y el historial.
- Consulte el **rendimiento de combustible** (km/L, L/100 km y $/km) por viaje, por vehículo y por chofer.
- Reciba una notificación cuando un chofer inicia, carga, sale o termina un viaje.

## Flujo del viaje

```
Asignado ──(foto odómetro)──▶ Rumbo a cargar / cargando ──▶ Cargado (en espera) ──▶ En ruta ──(foto odómetro)──▶ Finalizado
```

| Paso | Qué hace el chofer |
|---|---|
| **Iniciar viaje** | Foto del odómetro + lectura, antes de arrancar hacia la recolección |
| **Terminé de cargar** | Al terminar de subir la mercancía. El viaje puede quedarse “Cargado” horas o días |
| **Salir rumbo al destino** | Cuando arranca el viaje oficial (por ejemplo, al día siguiente) |
| **Finalizar viaje** | Foto del odómetro + lectura al entregar |

Así se cubre el caso de **cargar un día y salir al siguiente**: los km recorridos cuentan desde que el chofer sale a cargar hasta que entrega.

### Cálculo del rendimiento

```
km recorridos = odómetro final − odómetro inicial
km por litro  = km recorridos ÷ litros cargados durante el viaje
```

Para que el dato sea preciso se recomienda el método de **tanque lleno**: llenar el tanque al terminar cada viaje y registrar esa carga (el chofer con “⛽ Cargué combustible” o el administrador desde el detalle del viaje). Si el chofer escribe mal una lectura, el administrador la puede corregir en *Editar → Corregir lecturas del odómetro* comparando con la foto.

## Probarlo en tu computadora

Requiere [Node.js](https://nodejs.org/) 22.13 o más reciente.

```bash
npm install
npm start
```

Abre http://localhost:3000. La primera vez te pedirá crear la cuenta del administrador. Sin configurar nada más ya funciona todo: los correos se muestran en la consola y el mapa se reemplaza por un campo de dirección (se puede pegar un enlace de Google Maps).

Pruebas automáticas: `npm test`.

## Configuración (archivo `.env`)

Copia `.env.example` como `.env` y completa:

| Variable | Para qué |
|---|---|
| `COMPANY_NAME` | Nombre que aparece en la app y en los correos |
| `APP_URL` | Dirección pública (https) de la página, para los enlaces de los correos |
| `GOOGLE_MAPS_API_KEY` | Mapa y buscador de direcciones |
| `SMTP_*` | Envío de correos |
| `DATA_DIR` | Carpeta de la base de datos y fotos (**respáldala**) |

### Google Maps

1. Entra a [Google Cloud Console](https://console.cloud.google.com/), crea un proyecto y activa la facturación (Google da crédito gratis mensual; para una flota pequeña normalmente no se paga nada).
2. Habilita: **Maps JavaScript API**, **Places API (New)**, **Geocoding API** y **Maps Embed API**.
3. Crea una **clave de API** y restríngela a tu dominio (*Restricciones de aplicación → Sitios web → `https://viajes.tuempresa.com/*`*).
4. Ponla en `GOOGLE_MAPS_API_KEY`.

Los botones **Navegar** del chofer abren la app de Google Maps del celular y no consumen la API.

### Correo

Cualquier servidor SMTP sirve. Con **Gmail**: activa la verificación en dos pasos, crea una *contraseña de aplicación* y úsala en `SMTP_PASS` (`SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`). Para más volumen puedes usar Brevo, Resend, Amazon SES, etc.

### Notificaciones push e instalación en el celular

- Funcionan solo con **https** (o en `localhost`).
- **Android**: al abrir la página, en *Menú → Instalar en el celular* (o en el menú de Chrome → *Instalar app*). Luego *Activar notificaciones*.
- **iPhone (iOS 16.4 o más reciente)**: en Safari toca *Compartir → Agregar a pantalla de inicio*, abre la app desde ese ícono y toca *Activar notificaciones*. Apple no permite notificaciones si la página no está instalada.
- Si un chofer no activa las notificaciones, de todos modos recibe el **correo**.

## Publicarla en internet

La app es un solo proceso de Node con una base de datos SQLite en un archivo, así que funciona en cualquier servidor pequeño. Lo importante es que la carpeta `DATA_DIR` sea **persistente** y tenga **respaldo**.

- **Con Docker** (VPS de DigitalOcean, Hetzner, Lightsail, etc.):
  ```bash
  docker build -t fletes .
  docker run -d --name fletes -p 3000:3000 -v fletes-data:/data --env-file .env --restart unless-stopped fletes
  ```
  Pon delante un proxy con HTTPS (Caddy es lo más sencillo: `caddy reverse-proxy --from viajes.tuempresa.com --to :3000`).
- **Render / Railway / Fly.io**: crea el servicio desde este repositorio (usa el `Dockerfile`), agrega un **disco/volumen persistente** montado en `/data` y define las variables de entorno.

## Estructura

```
src/
  server.js   servidor web
  api.js      API: sesión, usuarios, vehículos, viajes, fotos, reportes
  db.js       base de datos SQLite (tablas)
  auth.js     contraseñas y sesiones
  notify.js   correos y notificaciones push
  config.js   variables de entorno
public/
  index.html  inicio de sesión / configuración inicial
  chofer.html pantalla del chofer
  admin.html  panel del administrador
  sw.js       service worker (instalación y notificaciones)
test/         pruebas automáticas
```
