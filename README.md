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
- Genere **recibos de pago** en PDF: pago semanal por destajo (semana **CW##**) y **bonos** con descripción.

## Recibos de pago

En la pestaña **Pagos** del administrador hay dos secciones:

- **Pagos semanales (destajo)**: eliges chofer y semana (`CW40 2026` = del lunes 28 sep al domingo 4 oct). La app muestra los viajes que el chofer terminó esa semana para incluirlos en el recibo, con importe por viaje opcional (el total se suma solo, pero puedes escribir otro). Puedes agregar conceptos extra (maniobras, casetas…). En **Notas** se propone un texto de lo que cubre el pago; si la semana no tiene viajes, se propone un texto genérico (“Pago a cuenta de servicios de flete por destajo…”) que puedes editar.
- **Bonos**: chofer, importe, **descripción** del bono y, si quieres, la semana a la que corresponde.

Cada recibo tiene folio (`P-00001` para pagos semanales y `B-00001` para bonos), importe con letra, forma de pago y referencia. El chofer recibe aviso (correo y notificación), lo ve en su pestaña **Pagos**, lo **descarga en PDF** y puede tocar **“Confirmo que recibí este pago”**; la confirmación queda registrada en el recibo. Un recibo con error se **cancela** (no se borra) para conservar el historial.

> Los recibos son comprobantes internos. Para el tratamiento fiscal de los pagos a choferes (facturas, retenciones, IMSS) consulta a tu contador.

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
| `COMPANY_NAME` | Nombre que aparece en la app, en los correos y en los recibos |
| `COMPANY_RFC`, `COMPANY_ADDRESS`, `COMPANY_PHONE` | Datos opcionales del encabezado de los recibos |
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

## Publicarla en Neubox

Neubox vende el dominio, el correo y el servidor. Para esta app se necesita un **VPS** (servidor virtual): el hosting compartido con cPanel normalmente no incluye Node.js 22, que es el que usa la app.

1. **Dominio**: compra `tuempresa.com` y, en la zona DNS, crea un registro **A** `viajes` → la IP de tu VPS (quedaría `https://viajes.tuempresa.com`).
2. **Correo**: crea una cuenta como `avisos@tuempresa.com` en el correo del dominio y usa sus datos SMTP en `.env` (normalmente `mail.tuempresa.com`, puerto 465, SSL). Los choferes pueden usar su correo personal (Gmail, Hotmail, etc.) para iniciar sesión y recibir los avisos.
3. **VPS con Ubuntu** (conéctate por SSH):
   ```bash
   # Node.js 22 y herramientas
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs git nginx certbot python3-certbot-nginx
   sudo npm install -g pm2

   # Descargar la app
   git clone https://github.com/jgpazvega-ae/AgentAN.git fletes && cd fletes
   npm ci --omit=dev
   cp .env.example .env && nano .env      # completa los datos

   # Encenderla y que arranque sola al reiniciar el servidor
   pm2 start ecosystem.config.js && pm2 save && pm2 startup
   ```
4. **Nginx + HTTPS gratis** (Let's Encrypt). Crea `/etc/nginx/sites-available/fletes`:
   ```nginx
   server {
     server_name viajes.tuempresa.com;
     client_max_body_size 15M;
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```
   ```bash
   sudo ln -s /etc/nginx/sites-available/fletes /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d viajes.tuempresa.com
   ```
5. **Respaldo**: copia periódicamente la carpeta `data/` (base de datos y fotos).
6. **Actualizar** cuando haya cambios: `git pull && npm ci --omit=dev && pm2 restart fletes`.

## Otras formas de publicarla

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
  payments.js API de recibos de pago (semanales y bonos)
  receipts.js PDF de los recibos e importe con letra
  weeks.js    semanas ISO (CW##)
  db.js       base de datos SQLite (tablas)
  auth.js     contraseñas y sesiones
  notify.js   correos y notificaciones push
  config.js   variables de entorno
public/
  index.html  inicio de sesión / configuración inicial
  chofer.html pantalla del chofer
  admin.html  panel del administrador (js/admin.js, js/admin-payments.js)
  sw.js       service worker (instalación y notificaciones)
test/         pruebas automáticas
```
