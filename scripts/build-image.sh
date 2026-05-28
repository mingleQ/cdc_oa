#!/usr/bin/env bash
# 构建可在腾讯云（linux/amd64）运行的镜像。
# better-sqlite3 是原生模块，必须为目标架构编译，否则在云上启动会报 invalid ELF / 找不到 .node。
#
# 在 Mac(arm64) 或任意机器上构建 amd64 镜像：
#   ./scripts/build-image.sh
# 然后导出给腾讯云（无镜像仓库时）：
#   docker save ggcdc-oa:latest | gzip > ggcdc-oa.tar.gz
#   scp ggcdc-oa.tar.gz user@腾讯云IP:/opt/ggcdc-oa/
#   # 云上： gunzip -c ggcdc-oa.tar.gz | docker load
set -euo pipefail

IMAGE="${1:-ggcdc-oa:latest}"
cd "$(dirname "$0")/.."

# 需要 docker buildx（Docker Desktop / 新版 docker 自带）
docker buildx build \
  --platform linux/amd64 \
  -t "$IMAGE" \
  --load \
  .

echo "已构建 amd64 镜像：$IMAGE"
echo "导出： docker save $IMAGE | gzip > ggcdc-oa.tar.gz"
