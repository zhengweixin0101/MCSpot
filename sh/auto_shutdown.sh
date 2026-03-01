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

log_info "初始化自动关服脚本..."
check_command jq
check_command curl

# 配置参数
IDLE_THRESHOLD="${IDLE_THRESHOLD:-5}" # 连续空闲次数阈值
CHECK_INTERVAL="${CHECK_INTERVAL:-120}" # 检测间隔（秒）

IDLE_COUNT=0
SHOULD_TERMINATE_ON_ERROR=true

# 删除实例函数
terminate_instance() {
    log_info "请求删除实例..."
    curl -s -u "$AUTH_USERNAME:$AUTH_PASSWORD" \
        "$API_BASE/api/terminate-instance"
    log_info "实例删除请求已发送"
}

# 错误清理函数
cleanup_on_error() {
    log_error "脚本异常退出，执行清理..."
    if [ "$SHOULD_TERMINATE_ON_ERROR" = true ]; then
        terminate_instance
    fi
    exit 1
}

trap cleanup_on_error ERR

log_info "开始监听 Minecraft 玩家状态..."
log_info "配置: 检测间隔 ${CHECK_INTERVAL}s, 空闲阈值 ${IDLE_THRESHOLD}次 (约 $((IDLE_THRESHOLD * CHECK_INTERVAL / 60)) 分钟)"

while true; do
    sleep "$CHECK_INTERVAL"

    # 检查停止标志
    if [ -f "$STOP_FLAG_FILE" ]; then
        log_info "检测到停止标志文件，自动关服脚本退出"
        exit 0
    fi

    # 获取状态，允许失败
    if ! STATUS_JSON=$(curl -s -f -u "$AUTH_USERNAME:$AUTH_PASSWORD" \
        "$API_BASE/api/mc/status"); then
        log_warn "获取服务器状态失败 (API请求错误)，跳过本次检测"
        continue
    fi

    # 解析状态，允许失败
    if ! ONLINE=$(echo "$STATUS_JSON" | jq -r '.mcOnline'); then
        log_warn "解析服务器状态失败 (JSON解析错误)，跳过本次检测"
        continue
    fi

    PLAYERS=$(echo "$STATUS_JSON" | jq -r '.playersOnline // 0')

    # 检查挂机模式
    AFK_MODE=$(echo "$STATUS_JSON" | jq -r '.afkMode // false')
    
    if [ "$ONLINE" == "true" ] && [ "$PLAYERS" -gt 0 ]; then
        IDLE_COUNT=0
        log_info "玩家在线: $PLAYERS，重置空闲计数"
    elif [ "$AFK_MODE" == "true" ]; then
        IDLE_COUNT=0
        log_info "挂机模式已开启，重置空闲计数"
    else
        IDLE_COUNT=$((IDLE_COUNT+1))
        log_info "无玩家在线，空闲计数: $IDLE_COUNT/$IDLE_THRESHOLD"
    fi

    # 达到空闲阈值
    if [ "$IDLE_COUNT" -ge "$IDLE_THRESHOLD" ]; then
        
        # 二次确认
        log_info "达到空闲阈值，进行二次确认（等待10s）..."
        sleep 10
        if STATUS_JSON=$(curl -s -f -u "$AUTH_USERNAME:$AUTH_PASSWORD" "$API_BASE/api/mc/status"); then
            ONLINE_CHECK=$(echo "$STATUS_JSON" | jq -r '.mcOnline')
            PLAYERS_CHECK=$(echo "$STATUS_JSON" | jq -r '.playersOnline // 0')
            AFK_MODE_CHECK=$(echo "$STATUS_JSON" | jq -r '.afkMode // false')
            if [ "$AFK_MODE_CHECK" == "true" ]; then
                log_info "二次确认发现挂机模式已开启，取消关服，重置计数"
                IDLE_COUNT=0
                continue
            elif [ "$ONLINE_CHECK" == "true" ] && [ "$PLAYERS_CHECK" -gt 0 ]; then
                log_info "二次确认发现玩家在线 ($PLAYERS_CHECK)，取消关服，重置计数"
                IDLE_COUNT=0
                continue
            fi
        fi

        # 尝试获取锁，避免与手动操作冲突
        exec 200>"$LOCK_FILE"
        if ! flock -n 200; then
             log_warn "检测到其他管理脚本正在运行，跳过本次自动关服"
             continue
        fi
        
        log_info "连续 $IDLE_COUNT 次检测无玩家，开始自动关服流程..."

        # 关闭 Minecraft 服务端
        stop_mc_server
        
        # 压缩备份
        if ! compress_world "world.zip"; then
             SHOULD_TERMINATE_ON_ERROR=false
             exit 1
        fi
        
        # 上传备份
        if ! upload_file "world.zip" "mc/world.zip"; then
             log_error "上传失败，保留实例"
             SHOULD_TERMINATE_ON_ERROR=false
             exit 1
        fi
        
        log_info "备份上传成功，即将删除实例..."
        terminate_instance
        
        log_info "自动关服流程完成"
        exit 0
    fi
done
