#!/usr/bin/env bash
#-----------------------------------------------------------------------------------------------
#  Ubuntu 一键入口：装 Node（缺则装）→ 调 setup.mjs 把 server.mjs 部署成 systemd 服务。
#
#  用法（在本目录，需 root）:
#    sudo bash setup.sh                 # 安装并启动（默认 /srv/universe-editor, 80 端口）
#    sudo bash setup.sh uninstall       # 卸载服务（保留发布目录）
#    sudo bash setup.sh status          # 查看服务状态
#    sudo bash setup.sh install --root /data/ue --port 8080 --base /ue/   # 自定义
#-----------------------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MAJOR=20

if [ "$(id -u)" -ne 0 ]; then
  echo -e "\033[31m✗ 请用 sudo 运行（写 systemd unit、绑 80 端口需 root）\033[0m" >&2
  exit 1
fi

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    echo "  Node 已就绪: $(node -v)"
    return
  fi
  echo "  未检测到 Node，正在安装 Node.js ${NODE_MAJOR}.x（NodeSource）…"
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update && apt-get install -y curl
  fi
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  echo "  Node 安装完成: $(node -v)"
  echo "  （内网无外网时此步会失败，请改用 tar.xz 离线包，详见 README）"
}

ensure_node
exec node "${SCRIPT_DIR}/setup.mjs" "$@"
