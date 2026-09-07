# Cloud Run image. The rendered scene data is baked in, so the container is self-contained
# and needs no bucket or volume mount at runtime.
FROM node:20-slim

WORKDIR /app

# Dependencies first so image layers cache across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY data ./data

# Cloud Run injects PORT (8080); server/config.js already reads it.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/index.js"]
