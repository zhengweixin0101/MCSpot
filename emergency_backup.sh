#!/bin/bash

MCS_DIR="/opt/mcs"
ENDPOINT="https://s3.cn-east-1.qiniucs.com"
BUCKET="zwxmc"

echo "[BACKUP] 开始紧急备份..."

# 检查目录是否存在
if [ ! -d "$MCS_DIR/world" ]; then
    echo "[BACKUP] 错误: 世界目录不存在 $MCS_DIR/world"
    exit 1
fi

# 进入 MC 服务器目录
cd "$MCS_DIR"

# 删除旧的备份文件（如果存在）
if [ -f "world_backup.zip" ]; then
    echo "[BACKUP] 删除旧备份文件..."
    rm -f world_backup.zip
fi

# 压缩世界数据
echo "[BACKUP] 正在压缩 world 目录..."
zip -r world_backup.zip world

if [ $? -ne 0 ]; then
    echo "[BACKUP] 压缩失败！"
    exit 1
fi

echo "[BACKUP] 压缩完成，文件大小: $(du -h world_backup.zip | cut -f1)"

# 上传到七牛 S3
echo "[BACKUP] 正在上传到 S3..."
aws s3 cp world_backup.zip "s3://$BUCKET/world_backup.zip" --endpoint-url "$ENDPOINT"

if [ $? -eq 0 ]; then
    echo "[BACKUP] ✓ 备份成功！world_backup.zip 已上传到 S3"
else
    echo "[BACKUP] ✗ 上传失败！"
    exit 1
fi