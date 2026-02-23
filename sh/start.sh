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
check_command screen
check_command java

AUTO_SHUTDOWN="${AUTO_SHUTDOWN:-/opt/sh/auto_shutdown.sh}"
AUTO_SHUTDOWN_LOG="${AUTO_SHUTDOWN_LOG:-/var/log/auto_shutdown.log}"
JAVA_MIN_MEM="${JAVA_MIN_MEM:-1024M}"
JAVA_MAX_MEM="${JAVA_MAX_MEM:-2048M}"

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
if screen -list | grep -q "$SCREEN_NAME"; then
    log_warn "Screen 会话 $SCREEN_NAME 已存在，跳过启动"
else
    if [ ! -f "$MC_JAR_PATH" ]; then
        log_error "Minecraft 服务端 JAR 文件不存在: $MC_JAR_PATH"
        exit 1
    fi
    log_info "启动 Minecraft 服务端..."
    # 启动 screen 时关闭 fd 200，防止锁泄漏
    screen -dmS "$SCREEN_NAME" bash -c "exec 200>&-; java -Xms\"$JAVA_MIN_MEM\" -Xmx\"$JAVA_MAX_MEM\" -jar \"$MC_JAR_PATH\" nogui"
    log_info "Minecraft 服务端已在 screen 会话中启动: $SCREEN_NAME"
fi

# 启动自动关服脚本
if [ -f "$AUTO_SHUTDOWN" ]; then
    chmod +x "$AUTO_SHUTDOWN"
    if pgrep -f "$AUTO_SHUTDOWN" > /dev/null 2>&1; then
        log_warn "自动关服脚本已在运行"
    else
        log_info "启动自动关服脚本..."
        # 启动后台进程时关闭 fd 200，防止锁泄漏
        nohup "$AUTO_SHUTDOWN" >> "$AUTO_SHUTDOWN_LOG" 2>&1 200>&- &
        log_info "自动关服脚本已后台运行"
    fi
else
    log_warn "自动关服脚本未找到: $AUTO_SHUTDOWN"
fi

log_info "启动流程完成"
