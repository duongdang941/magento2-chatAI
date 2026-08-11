FROM node:22-alpine

WORKDIR /srv/afd-ai-gateway

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY services ./services

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server.js"]
