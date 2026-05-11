FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build && npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
