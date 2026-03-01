#!/bin/bash
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail
if [ -n "${BASH_VERSION:-}" ]; then
    set -E
fi

# 日志函数
log_info() {
    echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_error() {
    echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

log_warn() {
    echo "[WARN] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# 检查依赖
check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "命令 $1 未找到，请先安装"
        exit 1
    fi
}

# 获取脚本所在目录
get_script_dir() {
    cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd
}

# 统一的公共库加载函数
load_library() {
    local lib_dir="$(get_script_dir)"
    local lib_file="$lib_dir/lib.sh"
    if [ -f "$lib_file" ]; then
        source "$lib_file"
    else
        echo "错误: 找不到 lib.sh" >&2
        exit 1
    fi
}

# 加载配置文件
LIB_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
CONFIG_FILE="$LIB_DIR/.env"
if [ -f "$CONFIG_FILE" ]; then
    set -a
    source "$CONFIG_FILE"
    set +a
fi

# 默认配置
MCS_DIR="${MCS_DIR:-/opt/mcs}"
MC_JAR="${MC_JAR:-server.jar}"
MC_JAR_PATH="$MCS_DIR/$MC_JAR"
STORAGE_TYPE="${STORAGE_TYPE:-s3}"
S3_ENDPOINT="${S3_ENDPOINT:-}"
S3_BUCKET="${S3_BUCKET:-}"
COS_BUCKET_ALIAS="${COS_BUCKET_ALIAS:-mcspot}"
API_BASE="${API_BASE:-http://localhost:3000}"
AUTH_USERNAME="${AUTH_USERNAME:-username}"
AUTH_PASSWORD="${AUTH_PASSWORD:-password}"
SCREEN_NAME="${SCREEN_NAME:-mcserver}"
STOP_FLAG_FILE="${LIB_DIR}/tmp/.server_stopped"
LOCK_FILE="${LIB_DIR}/tmp/.script_lock"
CONFIG_FILES="${CONFIG_FILES:-}"
MCS_START_COMMAND="${MCS_START_COMMAND:-java -Xms2G -Xmx3G -jar \"$MC_JAR_PATH\" nogui}"

# 脚本锁函数
script_lock() {
    local lock_dir
    lock_dir="$(dirname "$LOCK_FILE")"
    if [ ! -d "$lock_dir" ]; then
        if ! mkdir -p "$lock_dir"; then
            log_error "无法创建锁文件目录: $lock_dir"
            exit 1
        fi
    fi
    check_command flock
    
    # 使用文件描述符 200 作为锁文件
    # flock -n 表示非阻塞模式，如果锁被占用立即失败
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        log_error "另一个脚本正在运行，当前操作取消"
        # 尝试获取占用锁的进程信息
        fuser "$LOCK_FILE" 2>/dev/null || true
        exit 1
    fi
}

# 压缩备份
compress_world() {
    local target_file="$1"
    local source_dir="$MCS_DIR"
    
    if [ ! -d "$source_dir" ]; then
        log_error "Minecraft 目录不存在: $source_dir"
        return 1
    fi

    check_command zip
    
    # 使用子 shell 切换目录，避免影响当前目录
    (
        cd "$source_dir" || exit 1
        
        log_info "正在压缩 world 目录及配置文件..."
        rm -f "$target_file"
        
        # 检查 world 目录是否存在
        if [ ! -d "world" ]; then
            log_error "world 目录不存在，无法进行压缩"
            exit 1
        fi

        # 构建文件列表
        local files_to_zip=("world")
        
        # 如果环境变量未设置，使用默认配置文件列表
        local default_configs="server.properties eula.txt ops.json whitelist.json banned-players.json banned-ips.json usercache.json"
        local configs_to_check="${CONFIG_FILES:-$default_configs}"
        
        # 将字符串拆分为数组并检查文件是否存在
        for f in $configs_to_check; do
            if [ -f "$f" ]; then
                files_to_zip+=("$f")
            fi
        done

        if ! zip -r "$target_file" "${files_to_zip[@]}" > /dev/null 2>&1; then
            log_error "压缩命令执行失败"
            exit 1
        fi
            
        if [ ! -f "$target_file" ]; then
            log_error "压缩失败，文件未生成: $target_file"
            exit 1
        fi
        
        log_info "压缩完成: $target_file ($(du -h "$target_file" | cut -f1))"
    ) || return 1
    
    return 0
}

# 上传文件
upload_file() {
    local local_file="$1"
    local remote_path="$2" # 例如: mc/world.zip
    local resolved_file="$local_file"

    if [ ! -f "$resolved_file" ] && [[ "$resolved_file" != /* ]]; then
        if [ -f "$MCS_DIR/$resolved_file" ]; then
            resolved_file="$MCS_DIR/$resolved_file"
        fi
    fi

    if [ ! -f "$resolved_file" ]; then
        log_error "上传失败，本地文件不存在: $resolved_file"
        return 1
    fi

    if [ "$STORAGE_TYPE" = "cos" ]; then
        check_command coscli
        log_info "正在上传到腾讯云 COS..."
        if coscli cp "$resolved_file" "cos://${COS_BUCKET_ALIAS}/${remote_path}"; then
            log_info "上传成功 (COS)"
            return 0
        else
            log_error "上传失败 (COS)"
            return 1
        fi
    elif [ "$STORAGE_TYPE" = "s3" ]; then
        check_command aws
        log_info "正在上传到 S3..."
        if aws s3 cp "$resolved_file" "s3://${S3_BUCKET}/${remote_path}" --endpoint-url "$S3_ENDPOINT"; then
            log_info "上传成功 (S3)"
            return 0
        else
            log_error "上传失败 (S3)"
            return 1
        fi
    else
        log_error "不支持的存储类型: $STORAGE_TYPE"
        return 1
    fi
}

# 下载文件
download_file() {
    local remote_path="$1" # 例如: mc/world.zip
    local local_file="$2"

    if [ "$STORAGE_TYPE" = "cos" ]; then
        check_command coscli
        log_info "正在从腾讯云 COS 下载..."
        if coscli cp "cos://${COS_BUCKET_ALIAS}/${remote_path}" "$local_file"; then
            log_info "下载成功 (COS)"
            return 0
        else
            log_error "下载失败 (COS)"
            return 1
        fi
    elif [ "$STORAGE_TYPE" = "s3" ]; then
        check_command aws
        log_info "正在从 S3 下载..."
        if aws s3 cp "s3://${S3_BUCKET}/${remote_path}" "$local_file" --endpoint-url "$S3_ENDPOINT"; then
            log_info "下载成功 (S3)"
            return 0
        else
            log_error "下载失败 (S3)"
            return 1
        fi
    else
        log_error "不支持的存储类型: $STORAGE_TYPE"
        return 1
    fi
}

# 停止 Minecraft 服务器
stop_mc_server() {
    if pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
        log_info "正在关闭 Minecraft 服务端..."
        
        # 尝试通过 screen 发送 stop 命令
        if screen -list | grep -q "$SCREEN_NAME"; then
             log_info "发送 stop 命令..."
             screen -S "$SCREEN_NAME" -p 0 -X stuff "stop$(printf \\r)"
        fi

        # 循环等待停止，最多 60 秒
        local wait_seconds=60
        local count=0
        while [ $count -lt $wait_seconds ]; do
            if ! pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
                log_info "Minecraft 服务端已正常停止"
                return 0
            fi
            sleep 1
            count=$((count + 1))
            if [ $((count % 10)) -eq 0 ]; then
                log_info "正在等待服务器停止... ${count}s"
            fi
        done

        log_warn "服务器未在 $wait_seconds 秒内停止，尝试发送 SIGTERM..."
        # 如果还在运行，尝试 SIGTERM
        if pgrep -f "$MC_JAR_PATH" > /dev/null 2>&1; then
            pkill -f "$MC_JAR_PATH"
            sleep 10
        fi

        # 如果还在运行，强制 SIGKILL
        if pgrep -f "java.*$MC_JAR" > /dev/null 2>&1; then
            log_warn "强制杀掉未退出的服务端"
            pkill -9 -f "$MC_JAR_PATH"
        fi
    else
        log_info "Minecraft 服务端未运行"
    fi
}

# 启动 Minecraft 服务器
start_mc_server() {
    # 检查依赖
    check_command screen
    check_command java
    
    if [ ! -f "$MC_JAR_PATH" ]; then
        log_error "Minecraft 服务端 JAR 文件不存在: $MC_JAR_PATH"
        return 1
    fi
    
    # 检查 screen 会话是否已存在
    if screen -list | grep -q "$SCREEN_NAME"; then
        log_info "Screen 会话 $SCREEN_NAME 已存在，先停止现有服务器..."
        # 先停止现有的 Minecraft 服务器进程
        stop_mc_server
        # 等待一下确保完全停止
        sleep 2
        # 强制结束 screen 会话（如果还存在）
        if screen -list | grep -q "$SCREEN_NAME"; then
            log_info "结束现有的 screen 会话..."
            screen -S "$SCREEN_NAME" -X quit
            sleep 1
        fi
    fi
    
    log_info "启动 Minecraft 服务端..."
    
    local start_command="$MCS_START_COMMAND"
    start_command="${start_command//\$\{MC_JAR_PATH\}/$MC_JAR_PATH}"
    start_command="${start_command//\$MC_JAR_PATH/$MC_JAR_PATH}"
    start_command="${start_command//\$\{MCS_DIR\}/$MCS_DIR}"
    start_command="${start_command//\$MCS_DIR/$MCS_DIR}"
    start_command="${start_command//\$\{MC_JAR\}/$MC_JAR}"
    start_command="${start_command//\$MC_JAR/$MC_JAR}"
    
    log_info "启动命令: $start_command"
    screen -dmS "$SCREEN_NAME" bash -c "exec 200>&-; $start_command"
    log_info "Minecraft 服务端已在 screen 会话中启动: $SCREEN_NAME"
    return 0
}

# 启动自动关服脚本
start_auto_shutdown() {
    local AUTO_SHUTDOWN="${AUTO_SHUTDOWN:-$LIB_DIR/auto_shutdown.sh}"
    local AUTO_SHUTDOWN_LOG="${AUTO_SHUTDOWN_LOG:-$LIB_DIR/../logs/auto_shutdown.log}"
    
    if [ ! -f "$AUTO_SHUTDOWN" ]; then
        log_warn "自动关服脚本未找到: $AUTO_SHUTDOWN"
        return 1
    fi
    
    chmod +x "$AUTO_SHUTDOWN"

    # 一次性获取 PID 并检查，避免竞态条件
    local pid=$(pgrep -f "bash.*auto_shutdown.sh" | head -1)
    if [ -n "$pid" ]; then
        log_warn "自动关服脚本已在运行 (PID: $pid)"
        return 0
    fi
    
    # 检查是否有僵尸进程或挂起的进程
    if pgrep -f "auto_shutdown" > /dev/null 2>&1; then
        log_info "发现挂起的自动关服进程，正在清理..."
        pkill -f "auto_shutdown"
        sleep 1
    fi
    
    log_info "启动自动关服脚本..."
    # 启动后台进程时关闭 fd 200，防止锁泄漏
    nohup "$AUTO_SHUTDOWN" >> "$AUTO_SHUTDOWN_LOG" 2>&1 200>&- &
    
    # 等待一下确保启动成功
    sleep 2
    local new_pid=$(pgrep -f "bash.*auto_shutdown.sh" | head -1)
    if [ -n "$new_pid" ]; then
        log_info "自动关服脚本已后台运行 (PID: $new_pid)"
        return 0
    else
        log_error "自动关服脚本启动失败"
        return 1
    fi
}

# 停止自动关服脚本
stop_auto_shutdown() {
    # 一次性获取所有 PID，避免竞态条件
    local pids=$(pgrep -f "bash.*auto_shutdown.sh")
    if [ -n "$pids" ]; then
        log_info "停止自动关服脚本 (PIDs: $pids)..."
        
        # 先尝试正常停止
        pkill -TERM -f "bash.*auto_shutdown.sh"
        sleep 3
        
        # 检查是否还在运行
        local remaining_pids=$(pgrep -f "bash.*auto_shutdown.sh")
        if [ -n "$remaining_pids" ]; then
            log_warn "正常停止失败，强制终止..."
            pkill -KILL -f "bash.*auto_shutdown.sh"
            sleep 1
        fi
        
        # 最终检查
        local final_pids=$(pgrep -f "bash.*auto_shutdown.sh")
        if [ -n "$final_pids" ]; then
            log_error "无法停止自动关服脚本 (剩余 PIDs: $final_pids)"
            return 1
        else
            log_info "自动关服脚本已停止"
        fi
    else
        log_info "自动关服脚本未运行"
    fi
    return 0
}
