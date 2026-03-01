#!/bin/bash
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail
if [ -n "${BASH_VERSION:-}" ]; then
    set -E
fi

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# 加载公共库
if [ -f "$SCRIPT_DIR/lib.sh" ]; then
    source "$SCRIPT_DIR/lib.sh"
else
    echo "错误: 找不到 lib.sh"
    exit 1
fi

# 获取脚本锁，确保没有其他管理脚本运行
script_lock

log_info "创建停止标志文件..."
touch "$STOP_FLAG_FILE"

# 先停止自动关服脚本，防止干扰
stop_auto_shutdown

log_info "开始手动停止流程..."

# 检查服务是否运行
if pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
    # 停止 Minecraft 服务端
    stop_mc_server
else
    log_info "Minecraft 服务端未运行"
    # 如果服务未运行，直接退出，不执行后续的备份逻辑
    exit 0
fi

# 压缩备份
if ! compress_world "world.zip"; then
    log_error "备份打包失败"
    exit 1
fi

# 上传备份
if ! upload_file "world.zip" "mc/world.zip"; then
    log_error "备份上传失败"
    exit 1
fi

log_info "停止流程完成"
exit 0
