#!/bin/bash
set -Eeuo pipefail

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# 加载公共库
if [ -f "$SCRIPT_DIR/lib.sh" ]; then
    source "$SCRIPT_DIR/lib.sh"
else
    echo "错误: 找不到 lib.sh"
    exit 1
fi

# 获取脚本锁
script_lock

log_info "开始手动备份流程..."

# 获取日期时间
DATETIME=$(date +"%Y-%m-%d-%H-%M-%S")
BACKUP_FILE="world_backup_${DATETIME}.zip"

# 检查服务器是否运行
IS_RUNNING=false
if pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
    IS_RUNNING=true
fi

# 定义清理函数，确保恢复自动保存
cleanup() {
    if [ "$IS_RUNNING" = true ]; then
        if screen -list | grep -q "$SCREEN_NAME"; then
            log_info "恢复自动保存..."
            screen -S "$SCREEN_NAME" -p 0 -X stuff "save-on$(printf \\r)"
        fi
    fi
}
trap cleanup EXIT

if [ "$IS_RUNNING" = true ]; then
    log_info "服务器运行中，关闭自动保存并强制保存..."
    # 使用 screen 发送命令
    screen -S "$SCREEN_NAME" -p 0 -X stuff "save-off$(printf \\r)"
    screen -S "$SCREEN_NAME" -p 0 -X stuff "save-all$(printf \\r)"
    # 等待保存完成，大型世界可能需要更长时间
    log_info "等待保存完成 (10s)..."
    sleep 10
fi

# 压缩备份
if ! compress_world "$BACKUP_FILE"; then
    log_error "备份打包失败"
    exit 1
fi

# 上传备份
if ! upload_file "$BACKUP_FILE" "mc/$BACKUP_FILE"; then
    log_error "备份上传失败"
    exit 1
fi

log_info "备份流程完成"
exit 0
