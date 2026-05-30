# AN Mobility Group — WhatsApp AI Agent

Agente de IA que responde mensajes de WhatsApp automáticamente usando **Claude (Anthropic)** y la **API oficial de Meta (WhatsApp Cloud API)**.

## Requisitos previos

| Requisito | Dónde obtenerlo |
|-----------|----------------|
| **Docker Desktop** | [docs.docker.com/get-docker](https://docs.docker.com/get-docker/) |
| **Cuenta Meta for Developers** | [developers.facebook.com](https://developers.facebook.com/) |
| **WhatsApp Business API** activada | Panel de Meta for Developers |
| **API Key de Anthropic** | [console.anthropic.com](https://console.anthropic.com/) |
| **ngrok** (solo dev local) | [ngrok.com/download](https://ngrok.com/download) |

---

## Instalación en 4 pasos

### 1. Clonar el repositorio

```bash
git clone https://github.com/jgpazvega-ae/AgentAN.git
cd AgentAN
```

### 2. Ejecutar el setup

```bash
chmod +x setup.sh
./setup.sh
```

El script detecta Docker, crea el archivo `.env` y levanta el contenedor automáticamente.

### 3. Completar el `.env`

```env
WHATSAPP_TOKEN=tu_token_de_meta
WHATSAPP_PHONE_ID=tu_phone_id
WEBHOOK_VERIFY_TOKEN=cualquier_string_secreto
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Exponer el webhook (desarrollo local)

```bash
ngrok http 8000
```

Copia la URL que ngrok genera (ej: `https://abc123.ngrok-free.app`) y regístrala en Meta for Developers.

---

## Configurar el webhook en Meta

1. Entra a [developers.facebook.com](https://developers.facebook.com/) → Tu App → **WhatsApp → Configuration**
2. En **Webhook**, haz clic en **Edit**
3. Callback URL: `https://tu-url-publica/webhook`
4. Verify token: el mismo valor que pusiste en `WEBHOOK_VERIFY_TOKEN`
5. Suscríbete al evento **messages**
6. Haz clic en **Verify and Save**

---

## Comandos útiles

```bash
# Ver logs en vivo
docker compose logs -f

# Detener el agente
docker compose down

# Reiniciar tras cambios en .env
docker compose up -d --build

# Ver estado
docker compose ps
```

---

## Estructura del proyecto

```
├── app/
│   ├── main.py        # Webhook FastAPI (recibe y envía mensajes)
│   ├── agent.py       # Lógica del agente con Claude
│   ├── whatsapp.py    # Cliente WhatsApp Cloud API
│   └── config.py      # Variables de entorno
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── .env.example       # Plantilla de configuración
└── setup.sh           # Script de instalación
```

---

## Personalizar al agente

Edita el `SYSTEM_PROMPT` en `app/agent.py` para ajustar la personalidad, servicios, horarios de atención, etc.

---

## Deployment en producción

Para correr en un servidor (VPS, EC2, DigitalOcean, etc.) el proceso es idéntico — no necesitas ngrok porque el servidor ya tiene IP pública. Solo asegúrate de:

- Abrir el puerto `8000` en el firewall
- Usar HTTPS (puedes poner nginx + Certbot delante)
- Registrar `https://tu-dominio.com/webhook` en Meta

---

## Soporte

¿Problemas? Abre un issue en este repositorio.
