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

# 显示用法
usage() {
    echo "用法: $0 <存档文件名>"
    echo "示例: $0 world.zip"
    exit 1
}

# 检查参数
if [ $# -lt 1 ]; then
    usage
fi

ARCHIVE_NAME="$1"
REMOTE_PATH="mc/$ARCHIVE_NAME"
LOCAL_FILE="$MCS_DIR/restore.zip"

# 获取脚本锁
script_lock

# 检查依赖
check_command unzip

# 创建目录（如果不存在）
mkdir -p "$MCS_DIR"

log_info "开始回档流程，存档: $ARCHIVE_NAME"

# 检查服务器是否运行
WAS_RUNNING=false
if pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
    WAS_RUNNING=true
    log_info "服务器正在运行，即将停止..."
    touch "$STOP_FLAG_FILE"
    if pgrep -f "auto_shutdown.sh" > /dev/null 2>&1; then
        log_info "停止自动关服脚本..."
        pkill -f "auto_shutdown.sh"
    fi
    stop_mc_server
fi

# 下载存档
log_info "下载存档 $REMOTE_PATH ..."
if ! download_file "$REMOTE_PATH" "$LOCAL_FILE"; then
    log_error "下载存档失败: $REMOTE_PATH"
    exit 1
fi

# 检查下载的文件是否存在
if [ ! -f "$LOCAL_FILE" ]; then
    log_error "下载文件不存在: $LOCAL_FILE"
    exit 1
fi

cd "$MCS_DIR"

# 备份旧世界
if [ -d "world" ]; then
    log_info "备份旧世界..."
    rm -rf world.bak
    mv world world.bak
fi

# 解压存档
log_info "解压存档..."
if unzip -o "$LOCAL_FILE" > /dev/null 2>&1; then
    log_info "解压成功"
    rm -rf world.bak
    rm -f "$LOCAL_FILE"
else
    log_error "解压失败，尝试恢复备份..."
    if [ -d "world.bak" ]; then
        rm -rf world
        mv world.bak world
        log_info "已恢复旧世界"
    else
        log_warn "无旧世界可恢复，将保持现状"
    fi
    rm -f "$LOCAL_FILE"
    exit 1
fi

# 如果之前服务器在运行，则重新启动
if [ "$WAS_RUNNING" = true ]; then
    log_info "重新启动 Minecraft 服务端..."
    if [ -f "$STOP_FLAG_FILE" ]; then
        log_info "清理停止标志文件..."
        rm -f "$STOP_FLAG_FILE"
    fi

    check_command screen
    check_command java

    AUTO_SHUTDOWN="${AUTO_SHUTDOWN:-/opt/sh/auto_shutdown.sh}"
    AUTO_SHUTDOWN_LOG="${AUTO_SHUTDOWN_LOG:-/var/log/auto_shutdown.log}"
    JAVA_MIN_MEM="${JAVA_MIN_MEM:-1024M}"
    JAVA_MAX_MEM="${JAVA_MAX_MEM:-2048M}"

    if screen -list | grep -q "$SCREEN_NAME"; then
        log_warn "Screen 会话 $SCREEN_NAME 已存在，跳过启动"
    else
        if [ ! -f "$MC_JAR_PATH" ]; then
            log_error "Minecraft 服务端 JAR 文件不存在: $MC_JAR_PATH"
            exit 1
        fi
        log_info "启动 Minecraft 服务端..."
        screen -dmS "$SCREEN_NAME" bash -c "exec 200>&-; java -Xms\"$JAVA_MIN_MEM\" -Xmx\"$JAVA_MAX_MEM\" -jar \"$MC_JAR_PATH\" nogui"
        log_info "Minecraft 服务端已在 screen 会话中启动: $SCREEN_NAME"
    fi

    if [ -f "$AUTO_SHUTDOWN" ]; then
        chmod +x "$AUTO_SHUTDOWN"
        if pgrep -f "$AUTO_SHUTDOWN" > /dev/null 2>&1; then
            log_warn "自动关服脚本已在运行"
        else
            log_info "启动自动关服脚本..."
            nohup "$AUTO_SHUTDOWN" >> "$AUTO_SHUTDOWN_LOG" 2>&1 200>&- &
            log_info "自动关服脚本已后台运行"
        fi
    else
        log_warn "自动关服脚本未找到: $AUTO_SHUTDOWN"
    fi
fi

log_info "回档流程完成"
exit 0
