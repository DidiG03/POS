FROM node:20-slim

WORKDIR /app

# Prisma on Debian is more reliable than Alpine (musl).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY prisma ./prisma
COPY package.json package-lock.json* ./
RUN npm install
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]

