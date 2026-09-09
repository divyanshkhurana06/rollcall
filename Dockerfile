# Roll Call API. The web interface is static and deploys separately with VITE_API_BASE pointing here.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY data ./data
COPY scripts ./scripts

RUN npm ci --ignore-scripts

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["npx", "tsx", "apps/api/src/server.ts"]
