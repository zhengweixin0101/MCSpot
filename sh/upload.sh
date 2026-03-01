#!/bin/bash
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail
if [ -n "${BASH_VERSION:-}" ]; then
    set -E
fi

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

if [ -f "$SCRIPT_DIR/lib.sh" ]; then
    source "$SCRIPT_DIR/lib.sh"
else
    echo "错误: 找不到 lib.sh"
    exit 1
fi

script_lock

log_info "开始上传存档流程..."

TARGET_FILE="world.zip"
REMOTE_PATH="mc/world.zip"

IS_RUNNING=false
if pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
    IS_RUNNING=true
fi

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
    screen -S "$SCREEN_NAME" -p 0 -X stuff "save-off$(printf \\r)"
    screen -S "$SCREEN_NAME" -p 0 -X stuff "save-all$(printf \\r)"
    log_info "等待保存完成 (10s)..."
    sleep 10
fi

if ! compress_world "$TARGET_FILE"; then
    log_error "存档打包失败"
    exit 1
fi

if ! upload_file "$TARGET_FILE" "$REMOTE_PATH"; then
    log_error "存档上传失败"
    exit 1
fi

log_info "上传存档流程完成"
exit 0
