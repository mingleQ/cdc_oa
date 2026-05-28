FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV OA_DB_PATH=/app/data/oa.sqlite

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY scripts ./scripts
COPY index.html app.js styles.css legacy-browser.js browser-check.html ./
COPY docs ./docs
COPY OA功能测试用例.md OA角色冒烟测试报告.md OA正式版阶段验收记录.md README.md ./

RUN mkdir -p /app/data /app/uploads /app/backups \
  && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "server/server.js"]
