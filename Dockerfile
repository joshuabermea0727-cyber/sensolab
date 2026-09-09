# ---------------------------------------------------------------------------
# Imagen única: API + prototipo estático de SensoLab Community.
# Node 22 trae `node:sqlite` integrado, así que no hace falta compilar nada.
# ---------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app/backend

# 1) dependencias (capa cacheable)
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# 2) código del backend + el HTML que sirve en "/"
COPY backend/ ./
COPY index.html /app/index.html
COPY README.md /app/README.md

ENV NODE_ENV=production \
    PORT=4000 \
    SENSOLAB_DB_PATH=/data/sensolab.db

RUN mkdir -p /data
EXPOSE 4000

# seed idempotente en cada arranque + servidor
CMD ["sh", "docker-start.sh"]
