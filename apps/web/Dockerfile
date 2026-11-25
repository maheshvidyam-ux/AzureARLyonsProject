# Web SPA image (Container App, public ingress). Two stages:
#   1) build the Vite SPA against the workspace, then
#   2) serve the static bundle with nginx, reverse-proxying /api to the internal API container.
#
# The public ingress sits behind Entra Easy Auth; nginx forwards the injected
# `X-MS-CLIENT-PRINCIPAL` identity header to the API over the internal network.

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
# Install workspace deps (needs every workspace package.json present before `npm ci`).
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
# Produces apps/web/dist (tsc typecheck + vite build).
RUN npm --workspace @coa/web run build

# ---- serve ----
# nginx:1.27-alpine auto-runs envsubst over /etc/nginx/templates/*.template at startup,
# substituting ${API_UPSTREAM} (set at deploy) while leaving nginx vars like $host untouched.
FROM nginx:1.27-alpine
ENV API_UPSTREAM=http://localhost:8080
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
