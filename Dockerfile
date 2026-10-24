FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV FFPROBE_BIN=ffprobe
WORKDIR /app/server

# Перенаправляем data, uploads, clips на постоянный диск /var/data
CMD sh -c "mkdir -p /var/data/data /var/data/uploads /var/data/clips && \
  for d in data uploads clips; do rm -rf /app/server/$d; ln -s /var/data/$d /app/server/$d; done && \
  node server.js"
