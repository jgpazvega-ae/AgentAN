# AN Mobility Group · Página de la empresa y plataforma de viajes

El sitio tiene dos partes:

- **Página pública de la empresa** (`/`): presenta a AN Mobility Group a los clientes (servicios, nosotros, contacto, WhatsApp) e incluye un **formulario de cotización**. Arriba a la derecha está el botón **Iniciar sesión**.
- **Plataforma interna** (`/login.html`): choferes y administración. Se instala en el celular como una app (PWA).

Los textos y datos de contacto de la página pública se editan desde el panel, en la pestaña **Empresa** (nombre, frase principal, “Nosotros”, zona de servicio, teléfono, WhatsApp, correo, dirección y RFC). Las solicitudes de cotización llegan por correo y quedan en la pestaña **Cotizaciones**.

La plataforma sirve para que el chofer:

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

## Cotizador y tarifas

La página pública calcula un **precio estimado** según el servicio (**Flete** o **Viaje ejecutivo**), la unidad y el destino:

```
precio = tarifa base (incluye 40 km desde el centro de Querétaro) + km adicionales × tarifa por km
```

La distancia es por carretera y solo de ida (la tarifa por km ya considera el regreso). No incluye casetas, maniobras, esperas, viáticos ni IVA. Las unidades grandes (rabón/tórton) se muestran como **cotización especial**.

Propuesta inicial (se ajusta en el panel → **Empresa → Tarifas del cotizador**, con una tabla de ejemplos que se recalcula al escribir):

| Unidad | Base (hasta 40 km) | $ por km adicional | León (~171 km) | Puebla (~335 km) | Monterrey (~690 km)* |
|---|---:|---:|---:|---:|---:|
| Van de carga | $1,500 | $23 | $4,500 | $8,300 | $17,950 |
| Camioneta 3.5 t | $1,500 | $31 | $5,550 | $10,650 | $23,150 |
| Chevrolet Traverse / Toyota Sienna | $1,500 | $20 | $4,100 | $7,400 | $16,000 |
| Unidad grande | cotización especial | | | | |

\* Incluye viáticos del chofer: una noche ($1,500 de hotel y alimentos) por cada 450 km de distancia. Los montos de la tabla son con pago en efectivo o transferencia; el precio de lista (tarjeta) es 4% mayor.

### Impuestos y formas de pago

El cliente elige si es **persona física** o **empresa (persona moral)** y ve el desglose:

| | Persona física | Persona moral |
|---|---|---|
| IVA 16% | se suma | se suma |
| Retención de IVA 4% (solo fletes: art. 1-A fr. II inciso c LIVA) | — | se resta |
| Retención de ISR 1.25% (transportista persona física en RESICO: art. 113-J LISR) | — | se resta |

Ejemplo León en 3.5 t (subtotal $4,900): persona física **$5,684.00**; persona moral $4,900 + $784 − $196 − $61.25 = **$5,426.75**. En viajes ejecutivos (transporte de personas) no aplica la retención de IVA de fletes. Los porcentajes y a quién aplican se ajustan en el panel → Empresa → Tarifas; confírmalos con tu contador.

Formas de pago que se muestran: efectivo, transferencia y tarjeta de crédito o débito (terminal Mercado Pago). El cliente indica su preferida en la solicitud.

**Comisión de la tarjeta.** En México no se puede cobrar un recargo por pagar con tarjeta (Ley Federal de Protección al Consumidor; Profeco sanciona). Por eso el cotizador usa un **precio de lista** (el que se muestra y vale para cualquier forma de pago) y un **descuento por pago en efectivo o transferencia** (4% por defecto) que equivale a la comisión. Las tarifas de la tabla son el precio con descuento; por ejemplo, León en 3.5 t: lista $5,110, con transferencia $4,900 (más impuestos). El porcentaje se cambia en el panel → Empresa → Tarifas (0 = sin descuento).

La lista de destinos con sus distancias aproximadas está en `src/pricing.js`.

### Ruta con origen y destino (Google)

Con una llave de Google configurada, el cotizador muestra la opción **“Elegir origen y destino”**. El cliente busca de dónde sale y a dónde va (Places), y la **Routes API** calcula tres tramos: Querétaro → origen → destino → Querétaro. Se cobra la mitad de ese recorrido completo como “km equivalentes”. Si el origen es Querétaro, da lo mismo que la lista de destinos. Por ejemplo, León → Puebla: (171 + 480 + 335) / 2 = 493 km.

Qué hay que activar en [Google Cloud Console](https://console.cloud.google.com/), en el mismo proyecto y la misma llave del mapa del panel:

1. Facturación activa. Google da un crédito o cuota gratuita mensual; cada cotización con ruta usa 3 consultas de rutas y una sesión de búsqueda de lugares.
2. APIs: **Maps JavaScript API**, **Places API (New)** y **Routes API**. Para el panel también **Geocoding API** y **Maps Embed API**.
3. En *Credenciales*, restringe la llave:
   - **Sitios web**: `https://jgpazvega-ae.github.io/*`, tu dominio (`https://tudominio.com/*`) y, para pruebas, `http://localhost:3000/*`.
   - **APIs**: solo las de la lista anterior.
4. Recomendado: en *Cuotas*, pon un límite diario (por ejemplo 500 solicitudes por día en Routes API), y en *Facturación → Presupuestos* crea una alerta, porque la llave va visible en la página.
5. Pon la llave en `pages/sitio.json` → `google_maps_api_key` (GitHub Pages) y en `.env` → `GOOGLE_MAPS_API_KEY` (servidor). Si el cliente elige “Otro destino”, puede escribir los km. Cada solicitud guarda la unidad y el precio estimado que vio el cliente.

## Recibos de pago

En la pestaña **Pagos** del administrador hay dos secciones:

- **Pagos semanales (destajo)**: eliges chofer y semana (`CW40 2026` = del lunes 28 sep al domingo 4 oct). La app muestra los viajes que el chofer terminó esa semana para incluirlos en el recibo, con importe por viaje opcional (el total se suma solo, pero puedes escribir otro). Puedes agregar conceptos extra (maniobras, casetas…). En **Notas** se propone un texto de lo que cubre el pago; si la semana no tiene viajes, se propone un texto genérico (“Pago a cuenta de servicios de flete por destajo…”) que puedes editar.
- **Bonos**: chofer, importe, **descripción** del bono y, si quieres, la semana a la que corresponde.

Cada recibo tiene folio (`P-00001` para pagos semanales y `B-00001` para bonos), importe con letra, forma de pago y referencia. El chofer recibe aviso (correo y notificación), lo ve en su pestaña **Pagos**, lo **descarga en PDF** y puede tocar **“Confirmo que recibí este pago”**; la confirmación queda registrada en el recibo. Un recibo con error se **cancela** (no se borra) para conservar el historial.

> Los recibos son comprobantes internos. Para el tratamiento fiscal de los pagos a choferes (facturas, retenciones, IMSS) consulta a tu contador.

## Flujo del viaje

```
Asignado ─(foto odómetro)─▶ Rumbo a cargar ─▶ Cargado (en espera) ─(foto de la carga)─▶ En ruta
         ─(foto de llegada)─▶ En el punto de entrega ─(prueba de entrega + odómetro)─▶ Entregado
```

| Paso | Qué hace el chofer | Fotos que quedan en la plataforma |
|---|---|---|
| **Iniciar viaje** | Antes de arrancar hacia la recolección | Odómetro + lectura |
| **Terminé de cargar** | Al terminar de subir la mercancía. El viaje puede quedarse “Cargado” horas o días | — |
| **Salir rumbo al destino** | Cuando arranca el viaje oficial (por ejemplo, al día siguiente) | **Foto de la carga** |
| **Llegué al punto de entrega** | Al llegar al destino | **Foto de llegada** |
| **Entregar** | Al entregar | **Prueba de entrega** (1 a 3 fotos), **nombre de quien recibe**, **firma** en pantalla (opcional) y odómetro final |

Cada foto guarda fecha, hora y la ubicación del celular (si el chofer da permiso). El personal ve todas las fotos en el detalle del viaje. El cliente ve las de carga, llegada, entrega y firma, pero no las del odómetro ni los tickets de combustible.

Así se cubre el caso de **cargar un día y salir al siguiente**: los km recorridos cuentan desde que el chofer sale a cargar hasta que entrega.

## Perfiles de usuario

| Perfil | Qué puede hacer |
|---|---|
| **Superadministrador** (correo maestro) | Todo. Es la cuenta que se crea en la configuración inicial. Da de alta y modifica al personal de AN, los datos de la empresa y las tarifas. No se puede desactivar ni cambiar de perfil. |
| **Personal de AN** | Viajes, choferes, clientes, vehículos, pagos, rendimiento y cotizaciones. |
| **Chofer** | Ve sus viajes y registra cada etapa con fotos, combustible y notas. Ve sus recibos de pago. |
| **Cliente** | Entra a `/cliente.html`: sigue sus envíos en curso y su historial, con las fotos de carga, llegada y prueba de entrega. Recibe correo y notificación cuando su envío se programa, sale, llega y se entrega. |

Los usuarios se crean en el panel → **Usuarios** → **Nuevo usuario**, eligiendo el perfil. Al crear un viaje, se elige el **cliente con acceso** para que lo vea en su portal. Si la plataforma ya estaba en uso, al actualizar el primer administrador pasa a ser el superadministrador y se conservan todos los datos.

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

Abre http://localhost:3000 para ver la página de la empresa y http://localhost:3000/login.html para entrar. La primera vez te pedirá crear la cuenta del administrador. Sin configurar nada más ya funciona todo: los correos se muestran en la consola y el mapa se reemplaza por un campo de dirección (se puede pegar un enlace de Google Maps).

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

## Vista previa en GitHub Pages

Mientras se publica en Neubox, la **página de la empresa** (con el cotizador) se puede ver gratis en GitHub Pages. Es una versión estática: no hay inicio de sesión real y el formulario envía la solicitud por **WhatsApp** (o correo si no hay WhatsApp).

1. Edita `pages/sitio.json` en GitHub (ícono del lápiz) y pon al menos el **WhatsApp** a 10 dígitos.
2. En el repositorio: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Cada cambio que llegue a `main` publica la página (o ejecútalo a mano en **Actions → Página en GitHub Pages → Run workflow**).
4. La dirección queda como `https://<usuario>.github.io/<repositorio>/`.

GitHub Pages es gratis en repositorios públicos; en repositorios privados requiere un plan de pago de GitHub. Para generarla localmente: `node scripts/build-pages.js` (queda en `_site/`).

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

## Agente de WhatsApp con IA

La carpeta [`whatsapp-agent/`](whatsapp-agent/README.md) contiene el agente que responde mensajes de WhatsApp automáticamente con Claude (Python + FastAPI, WhatsApp Cloud API de Meta). Es un servicio independiente de esta plataforma: tiene su propio `.env`, `Dockerfile` y `docker-compose.yml`, y corre en el puerto 8000 (la plataforma usa el 3000). Instrucciones en [`whatsapp-agent/README.md`](whatsapp-agent/README.md).

## Estructura

```
src/
  server.js   servidor web
  api.js      API: sesión, usuarios, vehículos, viajes, fotos, reportes
  payments.js API de recibos de pago (semanales y bonos)
  receipts.js PDF de los recibos e importe con letra
  weeks.js    semanas ISO (CW##)
  site.js     datos de la empresa (se editan en el panel)
  site-api.js API de la página pública: datos de la empresa y cotizaciones
  views/home.html  página pública de la empresa
  db.js       base de datos SQLite (tablas)
  auth.js     contraseñas y sesiones
  notify.js   correos y notificaciones push
  config.js   variables de entorno
public/
  chofer.html pantalla del chofer
  login.html  inicio de sesión / configuración inicial
  admin.html  panel del administrador (js/admin.js, js/admin-payments.js, js/admin-site.js)
  cliente.html portal del cliente (js/client.js)
  img/        logotipo
  sw.js       service worker (instalación y notificaciones)
test/         pruebas automáticas
whatsapp-agent/  agente de WhatsApp con IA (Python, independiente)
```
