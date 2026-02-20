#!/bin/bash
set -Eeuo pipefail

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

# 校验必要变量
if [ -z "$MCS_DIR" ] || [ ! -d "$MCS_DIR" ]; then
    echo "[STOP] 错误: Minecraft 服务端目录无效: $MCS_DIR"
    exit 1
fi

if [ -z "$MC_JAR" ]; then
    echo "[STOP] 错误: MC_JAR 未设置"
    exit 1
fi

# 停止 Minecraft 服务端
if pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
    echo "[STOP] 关闭 Minecraft 服务端..."
    pkill -f "$MC_JAR_PATH"
    sleep 5

    if pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
        echo "[STOP] 强制杀掉未退出的服务端"
        pkill -9 -f "$MC_JAR_PATH"
    fi
else
    echo "[STOP] 未找到 Minecraft 服务端进程"
fi

sleep 5

# 停止 auto_shutdown.sh 脚本
if pgrep -f "^/opt/auto_shutdown.sh" > /dev/null 2>&1; then
    echo "[STOP] 停止 auto_shutdown.sh ..."
    pkill -f "^/opt/auto_shutdown.sh"
    sleep 2

    if pgrep -f "^/opt/auto_shutdown.sh" > /dev/null 2>&1; then
        echo "[STOP] 强制杀掉未退出的 auto_shutdown.sh"
        pkill -9 -f "^/opt/auto_shutdown.sh"
    fi
else
    echo "[STOP] 未找到 auto_shutdown.sh 进程"
fi

# 备份世界和配置文件
cd "$MCS_DIR"

rm -f world.zip

zip -r world.zip \
    world \
    server.properties \
    eula.txt \
    ops.json \
    whitelist.json \
    banned-players.json \
    banned-ips.json \
    usercache.json \
    > /dev/null

if [ ! -f "world.zip" ]; then
    echo "[STOP] 错误: world.zip 未生成"
    exit 1
fi

echo "[STOP] 世界数据和配置文件已打包为 world.zip"

# 上传到 S3
aws s3 cp world.zip \
    "s3://$S3_BUCKET/mc/world.zip" \
    --endpoint-url "$S3_ENDPOINT"

echo "[STOP] world.zip 上传完成"

echo "[STOP] 停止流程完成"