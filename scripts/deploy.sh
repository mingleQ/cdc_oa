#!/usr/bin/env bash
# 一键部署到生产服务器（PM2 模式，无 Docker）
#   ./scripts/deploy.sh        → 默认：push + git pull + pm2 reload，秒级
#   ./scripts/deploy.sh deps   → 同时 npm ci，用于 package.json 改动
set -euo pipefail

SERVER="ubuntu@114.132.97.36"
REMOTE_DIR="/home/ubuntu/cdc_oa"
MODE="${1:-reload}"

echo "→ 推送本地提交到 GitHub"
git push origin main

if [[ "$MODE" == "deps" ]]; then
  REMOTE_CMD="cd $REMOTE_DIR && git pull --ff-only && npm ci --omit=dev --no-audit --no-fund && set -a && source .env && set +a && pm2 reload ecosystem.config.js --update-env"
  echo "→ 服务器：git pull + npm ci + pm2 reload"
else
  REMOTE_CMD="cd $REMOTE_DIR && git pull --ff-only && set -a && source .env && set +a && pm2 reload ecosystem.config.js --update-env"
  echo "→ 服务器：git pull + pm2 reload（仅源码改动，秒级）"
fi

ssh "$SERVER" "$REMOTE_CMD"

echo "→ 健康检查"
ssh "$SERVER" 'sleep 2 && curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3000/api/health && pm2 jlist 2>/dev/null | python3 -c "import sys,json;a=json.load(sys.stdin);print(\"pm2:\", a[0][\"name\"], a[0][\"pm2_env\"][\"status\"], \"restarts=\"+str(a[0][\"pm2_env\"][\"restart_time\"]))" 2>/dev/null || pm2 status'
