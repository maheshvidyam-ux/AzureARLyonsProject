# API service image (Container App). Pragmatic runtime: runs TypeScript via tsx — a
# compiled/bundled image is a hardening follow-up. Mocks are NOT copied (quarantine, spec §18).
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install workspace deps (needs every workspace package.json present before `npm ci`).
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci

EXPOSE 8080
CMD ["npx", "tsx", "apps/api/src/index.ts"]
