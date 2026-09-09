# ---------------------------------------------------------------------------
# Imagen única: API + PWA (index.html) + sitio corporativo (site/).
# El servidor Express sirve los estáticos desde la raíz del repo (/app), así que
# un solo contenedor expone:
#   /          -> la app SensoLab Community
#   /site/     -> la web de SensoLab Solutions
#   /api/*     -> la API + el asistente de IA
# Node 22 trae `node:sqlite` integrado; no se compila nada.
# ---------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app/backend

# 1) dependencias del backend (capa cacheable)
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# 2) código del backend
COPY backend/ ./

# 3) estáticos que el server sirve desde /app
COPY index.html      /app/index.html
COPY config.js       /app/config.js
COPY remote.js       /app/remote.js
COPY remote-mock.js  /app/remote-mock.js
COPY site/           /app/site/
COPY README.md       /app/README.md

ENV NODE_ENV=production \
    PORT=4000 \
    SENSOLAB_DB_PATH=/data/sensolab.db

RUN mkdir -p /data
EXPOSE 4000

# seed idempotente en cada arranque + servidor
CMD ["sh", "docker-start.sh"]
