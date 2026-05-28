#!/usr/bin/env bash
# 一键部署到生产服务器
#   ./scripts/deploy.sh          → 代码改动，秒级 restart（默认）
#   ./scripts/deploy.sh build    → 改了 package.json / Dockerfile，触发完整 rebuild
#
# 流程：本地 git push → 服务器 git pull → restart 或 up --build
set -euo pipefail

SERVER="ubuntu@114.132.97.36"
REMOTE_DIR="/home/ubuntu/cdc_oa"
MODE="${1:-restart}"

echo "→ 推送本地提交到 GitHub"
git push origin main

if [[ "$MODE" == "build" ]]; then
  REMOTE_CMD="cd $REMOTE_DIR && git pull --ff-only && docker compose -f docker-compose.prod.yml up -d --build"
  echo "→ 服务器：git pull + 完整 rebuild（package.json / Dockerfile 变更模式）"
else
  REMOTE_CMD="cd $REMOTE_DIR && git pull --ff-only && docker compose -f docker-compose.prod.yml restart"
  echo "→ 服务器：git pull + restart（仅源码变更，秒级）"
fi

ssh "$SERVER" "$REMOTE_CMD"

echo "→ 健康检查"
ssh "$SERVER" 'sleep 4 && curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3000/api/health && docker ps --filter name=ggcdc-oa --format "{{.Status}}"'
