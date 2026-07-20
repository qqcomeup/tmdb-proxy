FROM node:22-alpine AS builder
WORKDIR /app
COPY server.js admin-dashboard.html package.json ./
COPY vendor ./vendor
RUN mkdir -p /tmp/tmdb-cache && chown -R 65532:65532 /tmp/tmdb-cache

FROM gcr.io/distroless/nodejs22-debian13
WORKDIR /app
ENV NODE_ENV=production PORT=54321
COPY --from=builder /app ./
COPY --from=builder --chown=65532:65532 /tmp/tmdb-cache /tmp/tmdb-cache
USER 65532:65532
EXPOSE 54321
CMD ["server.js"]
