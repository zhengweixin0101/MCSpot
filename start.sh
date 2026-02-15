#!/bin/bash
set -e

MCS_DIR="/opt/mcs"
MC_JAR="$MCS_DIR/1.21.11-server.jar"

ENDPOINT="https://s3.cn-east-1.qiniucs.com"
BUCKET="zwxmc"

AUTO_SHUTDOWN="/opt/auto_shutdown.sh"

mkdir -p "$MCS_DIR"
cd "$MCS_DIR"

echo "[START] 从七牛 S3 下载 world.zip ..."
aws s3 cp "s3://$BUCKET/world.zip" world.zip \
  --endpoint-url "$ENDPOINT"

echo "[START] 解压 world.zip ..."
unzip -o world.zip

echo "[START] 启动 Minecraft 服务端..."
nohup java -Xms512M -Xmx512M -jar "$MC_JAR" nogui > server.log 2>&1 &

MC_PID=$!
echo "[START] MC PID = $MC_PID"

# 确保 auto_shutdown.sh 可执行
chmod +x "$AUTO_SHUTDOWN"

echo "[START] 启动空闲监听脚本..."
nohup "$AUTO_SHUTDOWN" >> "$MCS_DIR/auto_shutdown.log" 2>&1 &

echo "[START] auto_shutdown.sh 已在后台运行"
echo "[START] 启动完成"