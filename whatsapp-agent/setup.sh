#!/bin/bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "======================================================"
echo "  AN Mobility Group — WhatsApp AI Agent · Setup"
echo "======================================================"
echo ""

# 1. Verificar Docker
if ! command -v docker &>/dev/null; then
  echo -e "${RED}✗ Docker no está instalado.${NC}"
  echo "  Instálalo desde: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  echo -e "${RED}✗ Docker Compose no está disponible.${NC}"
  echo "  Asegúrate de tener Docker Desktop o docker-compose-plugin."
  exit 1
fi

echo -e "${GREEN}✓ Docker listo${NC}"

# 2. Crear .env si no existe
if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${YELLOW}► Se creó el archivo .env a partir de .env.example${NC}"
  echo ""
  echo "  Por favor completa las variables en .env antes de continuar:"
  echo "    - WHATSAPP_TOKEN"
  echo "    - WHATSAPP_PHONE_ID"
  echo "    - WEBHOOK_VERIFY_TOKEN"
  echo "    - ANTHROPIC_API_KEY"
  echo ""
  read -p "  ¿Ya completaste el .env? (s/N): " confirm
  if [[ ! "$confirm" =~ ^[sS]$ ]]; then
    echo "  Edita el archivo .env y vuelve a ejecutar ./setup.sh"
    exit 0
  fi
else
  echo -e "${GREEN}✓ Archivo .env encontrado${NC}"
fi

# 3. Levantar el agente
echo ""
echo "► Construyendo y levantando el contenedor..."
docker compose up -d --build

echo ""
echo -e "${GREEN}======================================================"
echo "  ¡Agente iniciado!"
echo "======================================================"
echo -e "${NC}"
echo "  URL local:  http://localhost:8000"
echo "  Health:     http://localhost:8000/health"
echo "  Webhook:    http://localhost:8000/webhook"
echo ""
echo "  Para ver logs en vivo:"
echo "    docker compose logs -f"
echo ""
echo -e "${YELLOW}  IMPORTANTE: Para recibir mensajes de WhatsApp necesitas"
echo "  una URL pública. Usa ngrok para desarrollo local:"
echo ""
echo "    ngrok http 8000"
echo ""
echo "  Luego registra la URL en Meta for Developers:"
echo "    https://tu-subdominio.ngrok-free.app/webhook"
echo -e "${NC}"
