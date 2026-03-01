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

if [ -f "$STOP_FLAG_FILE" ]; then
    log_info "清理停止标志文件..."
    rm -f "$STOP_FLAG_FILE"
fi

log_info "开始启动流程..."

check_command unzip

mkdir -p "$MCS_DIR"
cd "$MCS_DIR"

# 下载存档
if ! download_file "mc/world.zip" "world.zip"; then
    log_warn "下载存档失败或存档不存在，将创建新世界"
fi

# 解压存档
if [ -f "world.zip" ]; then
    log_info "备份旧世界..."
    rm -rf world.bak
    if [ -d "world" ]; then
        mv world world.bak
    fi

    log_info "解压 world.zip..."
    if unzip -o world.zip > /dev/null 2>&1; then
        log_info "解压成功"
        rm -rf world.bak
    else
        log_error "解压失败，尝试恢复备份..."
        if [ -d "world.bak" ]; then
            rm -rf world
            mv world.bak world
            log_info "已恢复旧世界"
        else
            log_warn "无旧世界可恢复，将启动新世界"
        fi
    fi
fi

# 启动 Minecraft 服务端
if ! start_mc_server; then
    exit 1
fi

# 启动自动关服脚本
start_auto_shutdown

log_info "启动流程完成"
