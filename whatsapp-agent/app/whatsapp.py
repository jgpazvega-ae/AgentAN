import httpx
from app.config import settings


WHATSAPP_API_URL = "https://graph.facebook.com/v19.0"


async def send_message(to: str, text: str) -> dict:
    """Send a text message via WhatsApp Cloud API."""
    url = f"{WHATSAPP_API_URL}/{settings.WHATSAPP_PHONE_ID}/messages"
    headers = {
        "Authorization": f"Bearer {settings.WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "text",
        "text": {"body": text},
    }
    async with httpx.AsyncClient() as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()


async def mark_as_read(message_id: str) -> None:
    """Mark an incoming message as read."""
    url = f"{WHATSAPP_API_URL}/{settings.WHATSAPP_PHONE_ID}/messages"
    headers = {
        "Authorization": f"Bearer {settings.WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": message_id,
    }
    async with httpx.AsyncClient() as client:
        await client.post(url, headers=headers, json=payload)


def extract_message(payload: dict) -> tuple[str, str, str] | None:
    """
    Extract (sender_phone, message_text, message_id) from a webhook payload.
    Returns None if the payload doesn't contain a text message.
    """
    try:
        entry = payload["entry"][0]
        change = entry["changes"][0]
        value = change["value"]

        messages = value.get("messages")
        if not messages:
            return None

        msg = messages[0]
        if msg.get("type") != "text":
            return None

        sender = msg["from"]
        text = msg["text"]["body"]
        msg_id = msg["id"]
        return sender, text, msg_id
    except (KeyError, IndexError):
        return None
