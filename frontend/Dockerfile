# ─── Stage 1: build the SPA ────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Build-time env vars baked into the bundle. Empty BACKEND_URL keeps
# backend calls relative to the page origin (nginx proxies internally).
# Routing now hits Stadia Maps directly with an API key — supply it via
# the VITE_STADIA_API_KEY build arg or it'll be missing from the bundle.
ARG VITE_BACKEND_URL=""
ARG VITE_VALHALLA_URL="https://api.stadiamaps.com"
ARG VITE_STADIA_API_KEY=""
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL \
    VITE_VALHALLA_URL=$VITE_VALHALLA_URL \
    VITE_STADIA_API_KEY=$VITE_STADIA_API_KEY

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
