# ─── Stage 1: build the SPA ────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Build-time env vars baked into the bundle. Empty BACKEND_URL +
# /valhalla prefix mean every API call is relative to the page origin,
# which nginx then proxies internally to the right service.
ARG VITE_BACKEND_URL=""
ARG VITE_VALHALLA_URL="/valhalla"
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL \
    VITE_VALHALLA_URL=$VITE_VALHALLA_URL

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─── Stage 2: serve the static bundle through nginx ────────────
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
