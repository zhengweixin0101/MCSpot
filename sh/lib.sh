#!/bin/bash

# 加载配置文件
# 获取脚本所在目录
LIB_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
CONFIG_FILE="$LIB_DIR/.env"
if [ -f "$CONFIG_FILE" ]; then
    set -a
    source "$CONFIG_FILE"
    set +a
fi

# 默认配置
MCS_DIR="${MCS_DIR:-/opt/minecraft}"
MC_JAR="${MC_JAR:-server.jar}"
MC_JAR_PATH="$MCS_DIR/$MC_JAR"
STORAGE_TYPE="${STORAGE_TYPE:-s3}"
S3_ENDPOINT="${S3_ENDPOINT:-}"
S3_BUCKET="${S3_BUCKET:-}"
COS_BUCKET_ALIAS="${COS_BUCKET_ALIAS:-mcspot}"
API_BASE="${API_BASE:-http://localhost:3000}"
AUTH_USERNAME="${AUTH_USERNAME:-username}"
AUTH_PASSWORD="${AUTH_PASSWORD:-password}"
SCREEN_NAME="${SCREEN_NAME:-mc_server}"
STOP_FLAG_FILE="${MCS_DIR}/.server_stopped"
LOCK_FILE="${MCS_DIR}/.script_lock"

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

# 脚本锁函数
script_lock() {
    mkdir -p "$(dirname "$LOCK_FILE")"
    check_command flock
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        log_error "另一个脚本正在运行，当前操作取消"
        exit 1
    fi
}

# 检查依赖
check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "命令 $1 未找到，请先安装"
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
    
    cd "$source_dir" || return 1
    
    log_info "正在压缩 world 目录及配置文件..."
    rm -f "$target_file"
    
    # 检查 world 目录是否存在
    if [ ! -d "world" ]; then
        log_error "world 目录不存在，无法进行压缩"
        return 1
    fi

    # 构建文件列表，仅包含存在的文件
    FILES_TO_ZIP="world"
    for f in server.properties eula.txt ops.json whitelist.json banned-players.json banned-ips.json usercache.json; do
        if [ -f "$f" ]; then
            FILES_TO_ZIP="$FILES_TO_ZIP $f"
        fi
    done

    zip -r "$target_file" $FILES_TO_ZIP > /dev/null 2>&1
        
    if [ ! -f "$target_file" ]; then
        log_error "压缩失败，文件未生成: $target_file"
        return 1
    fi
    
    log_info "压缩完成: $target_file ($(du -h "$target_file" | cut -f1))"
    return 0
}

# 上传文件
upload_file() {
    local local_file="$1"
    local remote_path="$2" # 例如: mc/world.zip

    if [ ! -f "$local_file" ]; then
        log_error "上传失败，本地文件不存在: $local_file"
        return 1
    fi

    if [ "$STORAGE_TYPE" = "cos" ]; then
        check_command coscli
        log_info "正在上传到腾讯云 COS..."
        if coscli cp "$local_file" "cos://${COS_BUCKET_ALIAS}/${remote_path}"; then
            log_info "上传成功 (COS)"
            return 0
        else
            log_error "上传失败 (COS)"
            return 1
        fi
    elif [ "$STORAGE_TYPE" = "s3" ]; then
        check_command aws
        log_info "正在上传到 S3..."
        if aws s3 cp "$local_file" "s3://${S3_BUCKET}/${remote_path}" --endpoint-url "$S3_ENDPOINT"; then
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
