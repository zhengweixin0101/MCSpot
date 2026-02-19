#!/bin/bash
set -e

# 加载配置文件
CONFIG_FILE="/opt/.env"
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
fi

MCS_DIR="${MCS_DIR}" # Minecraft 服务端目录
MC_JAR="${MC_JAR}" # Minecraft 服务端 JAR 文件名
MC_JAR_PATH="$MCS_DIR/$MC_JAR" # JAR 文件完整路径
S3_ENDPOINT="${S3_ENDPOINT}" # S3 兼容存储服务 URL
S3_BUCKET="${S3_BUCKET}" # S3 存储桶名称

echo "[STOP] 开始手动停止流程..."

# 停止 Minecraft 服务端
MC_PID=$(pgrep -f "$MC_JAR_PATH")
if [ -n "$MC_PID" ]; then
    echo "[STOP] 关闭 Minecraft 服务端 PID=$MC_PID"
    kill "$MC_PID"
    # 等待进程完全退出
    sleep 5
    if ps -p "$MC_PID" > /dev/null 2>&1; then
        echo "[STOP] 强制杀掉未退出的服务端"
        kill -9 "$MC_PID"
    fi
else
    echo "[STOP] 未找到 Minecraft 服务端进程"
fi

sleep 5

# 停止 auto_shutdown.sh 脚本（通过精确路径匹配）
AUTO_PID=$(pgrep -f "^/opt/auto_shutdown.sh")
if [ -n "$AUTO_PID" ]; then
    echo "[STOP] 停止 auto_shutdown.sh PID=$AUTO_PID"
    kill "$AUTO_PID"
    sleep 2
    if ps -p "$AUTO_PID" > /dev/null 2>&1; then
        kill -9 "$AUTO_PID"
    fi
else
    echo "[STOP] 未找到 auto_shutdown.sh 进程"
fi

# 备份世界和配置文件
cd "$MCS_DIR"
rm -f world.zip
zip -r world.zip world server.properties eula.txt ops.json whitelist.json banned-players.json banned-ips.json usercache.json 2>/dev/null || true
echo "[STOP] 世界数据和配置文件已打包为 world.zip"

# 上传到 S3
aws s3 cp world.zip "s3://$S3_BUCKET/mc/world.zip" --endpoint-url "$S3_ENDPOINT"
echo "[STOP] world.zip 上传完成"

echo "[STOP] 停止流程完成"
