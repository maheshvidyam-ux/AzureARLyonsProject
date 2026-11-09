# Workers image (Container App). Consumes the Service Bus ingestion queue and runs the
# pipeline (Graph fetch → DI → AI Foundry → normalize/validate → Fabric SQL). Runs via tsx.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci

CMD ["npx", "tsx", "apps/workers/src/index.ts"]
