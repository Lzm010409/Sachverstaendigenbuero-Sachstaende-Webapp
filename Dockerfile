# Sachstands-Cockpit — Produktions-Image für Coolify
FROM node:20-alpine

WORKDIR /app

# Abhängigkeiten zuerst (Layer-Caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Anwendungscode
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
# PORT wird von Coolify gesetzt; Standard 3000 für lokale Läufe
ENV PORT=3000
EXPOSE 3000

# Healthcheck nutzt den /api/health-Endpunkt
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server/index.js"]
