import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import PlainTextResponse

from app.config import settings
from app.whatsapp import extract_message, mark_as_read, send_message
from app.agent import get_ai_response

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("AN Mobility Group — WhatsApp AI Agent iniciado")
    yield


app = FastAPI(
    title="AN Mobility Group — WhatsApp AI Agent",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/webhook")
async def verify_webhook(request: Request):
    """
    Meta llama a este endpoint para verificar el webhook.
    Debe devolver el hub.challenge si el token es correcto.
    """
    params = dict(request.query_params)
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    if mode == "subscribe" and token == settings.WEBHOOK_VERIFY_TOKEN:
        logger.info("Webhook verificado correctamente")
        return PlainTextResponse(content=challenge)

    raise HTTPException(status_code=403, detail="Token de verificación incorrecto")


@app.post("/webhook")
async def receive_message(request: Request):
    """
    Meta envía los mensajes entrantes aquí.
    Procesamos el mensaje y respondemos con Claude.
    """
    payload = await request.json()
    logger.debug("Payload recibido: %s", payload)

    result = extract_message(payload)
    if result is None:
        # Puede ser una notificación de estado, delivery receipt, etc.
        return Response(status_code=200)

    sender, text, msg_id = result
    logger.info("Mensaje de %s: %s", sender, text)

    # Marcar como leído (doble check azul)
    try:
        await mark_as_read(msg_id)
    except Exception:
        pass  # No crítico

    # Generar respuesta con Claude
    try:
        reply = get_ai_response(sender, text)
    except Exception as exc:
        logger.error("Error generando respuesta: %s", exc)
        reply = "Estamos teniendo problemas técnicos. Por favor intenta de nuevo en unos minutos."

    # Enviar respuesta
    try:
        await send_message(sender, reply)
        logger.info("Respuesta enviada a %s", sender)
    except Exception as exc:
        logger.error("Error enviando mensaje a %s: %s", sender, exc)

    return Response(status_code=200)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "AN Mobility Group WhatsApp Agent"}
