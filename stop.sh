#!/bin/bash
set -e

MCS_DIR="/opt/mcs"
ENDPOINT="https://3e074a499835faf39e26a69ca96198e9.r2.cloudflarestorage.com"
BUCKET="cdn"

echo "[STOP] 开始手动停止流程..."

# 停止 Minecraft 服务端
MC_PID=$(pgrep -f "/opt/mcs/1.21.11-server.jar")
if [ -n "$MC_PID" ]; then
    echo "[STOP] 关闭 Minecraft 服务端 PID=$MC_PID"
    kill $MC_PID
    # 等待进程完全退出
    sleep 5
    if ps -p $MC_PID > /dev/null; then
        echo "[STOP] 强制杀掉未退出的服务端"
        kill -9 $MC_PID
    fi
else
    echo "[STOP] 未找到 Minecraft 服务端进程"
fi

sleep 5

# 停止 auto_shutdown.sh 脚本
AUTO_PID=$(pgrep -f "auto_shutdown.sh")
if [ -n "$AUTO_PID" ]; then
    echo "[STOP] 停止 auto_shutdown.sh PID=$AUTO_PID"
    kill $AUTO_PID
    sleep 2
    if ps -p $AUTO_PID > /dev/null; then
        kill -9 $AUTO_PID
    fi
else
    echo "[STOP] 未找到 auto_shutdown.sh 进程"
fi

# 备份世界
cd "$MCS_DIR"
rm -f world.zip
zip -r world.zip world
echo "[STOP] 世界数据已打包为 world.zip"

# 上传到 S3
aws s3 cp world.zip "s3://$BUCKET/mc/world.zip" --endpoint-url "$ENDPOINT"
echo "[STOP] world.zip 上传完成"

echo "[STOP] 停止流程完成"
