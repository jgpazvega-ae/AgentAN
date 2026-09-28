import anthropic
from app.config import settings


SYSTEM_PROMPT = """Eres el asistente virtual de **AN Mobility Group**, empresa de fletes y logística.

Tu rol es atender a clientes y potenciales clientes por WhatsApp de forma profesional, amigable y eficiente.

**Servicios que ofrecemos:**
- Transporte de carga terrestre (local, regional, nacional)
- Logística integral y gestión de envíos
- Mudanzas residenciales y corporativas
- Distribución y última milla
- Almacenamiento y bodegaje temporal

**Cómo responder:**
- Saluda de forma amigable si es el primer mensaje.
- Si preguntan por un servicio, pide detalles: origen, destino, tipo de carga, fecha y peso/volumen aproximado.
- Si preguntan precios, indica que necesitas los detalles del envío para dar una cotización precisa.
- Si hay quejas, muestra empatía y ofrece escalar con un agente humano.
- Responde siempre en el mismo idioma que el cliente.
- Mensajes cortos y directos. WhatsApp no es un correo.

**Si no puedes resolver algo:**
Responde: "Voy a comunicarte con uno de nuestros agentes para darte atención personalizada. En breve te contactamos."

No inventes precios, rutas ni tiempos de entrega específicos sin datos reales.
"""


_client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

# In-memory conversation history keyed by phone number.
# For production, replace with a persistent store (Redis, DB, etc.)
_conversations: dict[str, list[dict]] = {}


def get_ai_response(phone: str, user_message: str) -> str:
    """Generate a response from Claude for the given user message."""
    history = _conversations.setdefault(phone, [])

    history.append({"role": "user", "content": user_message})

    # Keep only last 20 turns to avoid token overflow
    recent = history[-20:]

    response = _client.messages.create(
        model=settings.CLAUDE_MODEL,
        max_tokens=500,
        system=SYSTEM_PROMPT,
        messages=recent,
    )

    assistant_text = response.content[0].text
    history.append({"role": "assistant", "content": assistant_text})

    return assistant_text


def clear_history(phone: str) -> None:
    """Clear conversation history for a phone number."""
    _conversations.pop(phone, None)
