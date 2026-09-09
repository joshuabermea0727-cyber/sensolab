#!/bin/sh
# Arranque dentro del contenedor: siembra datos demo (idempotente) y levanta la API.
set -e

echo "· sembrando datos demo (si faltan)…"
node --disable-warning=ExperimentalWarning seed.js

echo "· iniciando servidor…"
exec node --disable-warning=ExperimentalWarning server.js
