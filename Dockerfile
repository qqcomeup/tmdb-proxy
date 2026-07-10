FROM node:22-alpine AS builder
WORKDIR /app
COPY server.js admin-dashboard.html package.json ./

FROM gcr.io/distroless/nodejs22-debian13
WORKDIR /app
ENV NODE_ENV=production PORT=54321
COPY --from=builder /app ./
EXPOSE 54321
CMD ["server.js"]
