#!/bin/bash

MCS_DIR="/opt/mcs"
ENDPOINT="https://3e074a499835faf39e26a69ca96198e9.r2.cloudflarestorage.com"
BUCKET="cdn"

echo "[BACKUP] 开始备份..."

# 检查目录是否存在
if [ ! -d "$MCS_DIR/world" ]; then
    echo "[BACKUP] 错误: 世界目录不存在 $MCS_DIR/world"
    exit 1
fi

# 进入 MC 服务器目录
cd "$MCS_DIR"

# 获取日期时间
DATETIME=$(date +"%Y-%m-%d-%H-%M-%S")
BACKUP_FILE="world_backup_${DATETIME}.zip"

echo "[BACKUP] 备份文件名: $BACKUP_FILE"

# 压缩世界数据和配置文件
echo "[BACKUP] 正在压缩 world 目录和配置文件..."
zip -r "$BACKUP_FILE" world server.properties eula.txt ops.json whitelist.json banned-players.json banned-ips.json usercache.json 2>/dev/null || true

if [ $? -ne 0 ]; then
    echo "[BACKUP] 压缩失败！"
    exit 1
fi

echo "[BACKUP] 压缩完成，文件大小: $(du -h "$BACKUP_FILE" | cut -f1)"

# 上传到 S3
echo "[BACKUP] 正在上传到 S3..."
aws s3 cp "$BACKUP_FILE" "s3://$BUCKET/mc/$BACKUP_FILE" --endpoint-url "$ENDPOINT"

if [ $? -eq 0 ]; then
    echo "[BACKUP] ✓ 备份成功！$BACKUP_FILE 已上传到 S3"
else
    echo "[BACKUP] ✗ 上传失败！"
    exit 1
fi