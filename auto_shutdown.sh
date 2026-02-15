#!/bin/bash
set -e

# ------------------------
# 配置
# ------------------------
MCS_DIR="/opt/mcs"
WORLD_DIR="$MCS_DIR/world"
ZIP_FILE="$MCS_DIR/world.zip"

ENDPOINT="https://s3.cn-east-1.qiniucs.com"
BUCKET="zwxmc"
INSTANCE_ID="ins-p0b0thon"

IDLE_SECONDS=0
IDLE_THRESHOLD=30  # 空闲30秒自动关服

# ------------------------
# 获取本机 IP（公网 IP）
# ------------------------
IP=$(curl -s https://api.ipify.org)
if [ -z "$IP" ]; then
    echo "[ERROR] 获取本机公网 IP 失败"
    exit 1
fi

echo "[AUTO] 开始监听 Minecraft 在线玩家，服务器 IP: $IP"

while true; do
    sleep 10  # 每10秒查询一次

    # 查询 Minecraft Server Status API
    JSON=$(curl -s -A "Mozilla/5.0" "https://api.mcsrvstat.us/3/$IP")

    ONLINE=$(echo "$JSON" | jq -r '.online')
    PLAYERS=$(echo "$JSON" | jq -r '.players.online // 0')

    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

    if [ "$ONLINE" != "true" ] || [ "$PLAYERS" -eq 0 ]; then
        IDLE_SECONDS=$((IDLE_SECONDS + 10))
        echo "$TIMESTAMP 无玩家在线，空闲 $IDLE_SECONDS 秒"
    else
        IDLE_SECONDS=0
        echo "$TIMESTAMP 玩家在线: $PLAYERS"
    fi

    # 空闲达到阈值，开始自动关服
    if [ "$IDLE_SECONDS" -ge "$IDLE_THRESHOLD" ]; then
        echo "$TIMESTAMP 空闲 $IDLE_SECONDS 秒，开始自动关服..."

        # 停止 MC 服务端
        PID=$(pgrep -f "1.21.11-server.jar" || true)
        if [ -n "$PID" ]; then
            echo "[AUTO] 停止 Minecraft 服务端 (PID=$PID)..."
            kill "$PID"
            sleep 5
        fi

        # 压缩 world 文件夹
        echo "[AUTO] 压缩 world 文件夹..."
        if command -v zip >/dev/null 2>&1; then
            rm -f "$ZIP_FILE"
            zip -r "$ZIP_FILE" "$WORLD_DIR"
        else
            echo "[ERROR] zip 命令未安装，请先安装 zip"
            exit 1
        fi

        # 上传到七牛 S3
        echo "[AUTO] 上传 world.zip 到七牛 S3..."
        aws s3 cp "$ZIP_FILE" "s3://$BUCKET/world.zip" --endpoint-url "$ENDPOINT"

        echo "[AUTO] 确认上传..."
        aws s3 ls "s3://$BUCKET/world.zip" --endpoint-url "$ENDPOINT"

        # 通知本地 API 删除实例
        #echo "[AUTO] 通知本地 API 删除实例..."
        #curl -fsS "http://localhost:3000/api/terminate-instance?instanceId=$INSTANCE_ID"

        echo "[AUTO] 自动关服完成"
        exit 0
    fi
done