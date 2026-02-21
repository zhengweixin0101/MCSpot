#!/bin/bash
set -e

# 加载配置文件
CONFIG_FILE="/opt/.env"
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
fi

MCS_DIR="${MCS_DIR}" # Minecraft 服务端目录

STORAGE_TYPE="${STORAGE_TYPE:-s3}" # 存储方式: s3 或 cos

# S3 配置
S3_ENDPOINT="${S3_ENDPOINT}" # S3 兼容存储服务 URL
S3_BUCKET="${S3_BUCKET}" # S3 存储桶名称

# 腾讯云 COS 配置
COS_BUCKET_ALIAS="${COS_BUCKET_ALIAS:-mcspot}" # COS 存储桶别名

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

# 根据存储类型上传备份
if [ "$STORAGE_TYPE" = "cos" ]; then
    echo "[BACKUP] 正在上传到腾讯云 COS..."
    coscli cp "$BACKUP_FILE" "cos://${COS_BUCKET_ALIAS}/mc/$BACKUP_FILE"
    if [ $? -eq 0 ]; then
        echo "[BACKUP] ✓ 备份成功！$BACKUP_FILE 已上传到 COS"
    else
        echo "[BACKUP] ✗ 上传失败！"
        exit 1
    fi
elif [ "$STORAGE_TYPE" = "s3" ]; then
    echo "[BACKUP] 正在上传到 S3..."
    aws s3 cp "$BACKUP_FILE" "s3://$S3_BUCKET/mc/$BACKUP_FILE" --endpoint-url "$S3_ENDPOINT"
    if [ $? -eq 0 ]; then
        echo "[BACKUP] ✓ 备份成功！$BACKUP_FILE 已上传到 S3"
    else
        echo "[BACKUP] ✗ 上传失败！"
        exit 1
    fi
else
    echo "[BACKUP] 错误: 不支持的存储类型 $STORAGE_TYPE，请使用 s3 或 cos"
    exit 1
fi