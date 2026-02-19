#!/bin/bash
set -e

MC_JAR="/opt/mcs/1.21.11-server.jar"

ENDPOINT="https://3e074a499835faf39e26a69ca96198e9.r2.cloudflarestorage.com"
BUCKET="cdn"

AUTO_SHUTDOWN="/opt/auto_shutdown.sh"

mkdir -p /opt/mcs
cd /opt/mcs

echo "[START] 从 S3 下载 world.zip ..."
aws s3 cp "s3://$BUCKET/mc/world.zip" world.zip \
  --endpoint-url "$ENDPOINT"

echo "[START] 清理旧的 world 文件夹..."
rm -rf world

echo "[START] 解压 world.zip ..."
unzip -o world.zip

echo "[START] 启动 Minecraft 服务端..."
screen -dmS mcserver java -Xms1G -Xmx2G -jar "$MC_JAR" nogui

echo "[START] Minecraft 服务端已在 screen 会话中启动"
echo "[START] 使用 'screen -r mcserver' 进入控制台"
echo "[START] 按 Ctrl+A 然后按 D 退出控制台但保持服务运行"

# 确保 auto_shutdown.sh 可执行
chmod +x "$AUTO_SHUTDOWN"

echo "[START] 启动空闲监听脚本..."
nohup "$AUTO_SHUTDOWN" >> "/opt/auto_shutdown.log" 2>&1 &

echo "[START] auto_shutdown.sh 已在后台运行"
echo "[START] 启动完成"