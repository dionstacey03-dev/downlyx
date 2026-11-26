FROM oven/bun:1-alpine

RUN apk add --no-cache ffmpeg   && addgroup -S downlyx   && adduser -S -G downlyx downlyx

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ARG VITE_FIREBASE_API_KEY
ENV VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY}
RUN bun run build   && mkdir -p /tmp/downlyx-media-tmp   && chown -R downlyx:downlyx /app /tmp/downlyx-media-tmp

USER downlyx

ENV NODE_ENV=production
ENV PORT=3000
ENV TMPDIR=/tmp/downlyx-media-tmp

EXPOSE 3000

# Bun executes the TypeScript entrypoint and starts the API + local worker
# child processes. The container must be run with a strong session secret,
# Firebase Admin ADC/service-account credentials, a read-only root filesystem,
# and a bounded writable /tmp.
CMD ["bun", "run", "server.ts"]
