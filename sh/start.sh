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

AUTO_SHUTDOWN="${AUTO_SHUTDOWN}" # auto_shutdown.sh 脚本路径
AUTO_SHUTDOWN_LOG="${AUTO_SHUTDOWN_LOG}" # auto_shutdown.sh 日志文件

SCREEN_NAME="${SCREEN_NAME}" # screen 会话名称
JAVA_MIN_MEM="${JAVA_MIN_MEM}" # Java 最小内存
JAVA_MAX_MEM="${JAVA_MAX_MEM}" # Java 最大内存

mkdir -p "$MCS_DIR"
cd "$MCS_DIR"

echo "[START] 从 S3 下载 world.zip ..."
aws s3 cp "s3://$S3_BUCKET/mc/world.zip" world.zip --endpoint-url "$S3_ENDPOINT"

echo "[START] 清理旧的 world 文件夹..."
rm -rf world

echo "[START] 解压 world.zip ..."
unzip -o world.zip

echo "[START] 启动 Minecraft 服务端..."
screen -dmS "$SCREEN_NAME" java -Xms"$JAVA_MIN_MEM" -Xmx"$JAVA_MAX_MEM" -jar "$MC_JAR_PATH" nogui

echo "[START] Minecraft 服务端已在 screen 会话中启动"
echo "[START] 使用 'screen -r $SCREEN_NAME' 进入控制台"
echo "[START] 按 Ctrl+A 然后按 D 退出控制台但保持服务运行"

# 确保 auto_shutdown.sh 可执行
chmod +x "$AUTO_SHUTDOWN"

echo "[START] 启动空闲监听脚本..."
nohup "$AUTO_SHUTDOWN" >> "$AUTO_SHUTDOWN_LOG" 2>&1 &

echo "[START] auto_shutdown.sh 已在后台运行"
echo "[START] 启动完成"
