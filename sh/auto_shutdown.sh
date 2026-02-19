#!/bin/bash

# 加载配置文件
CONFIG_FILE="/opt/.env"
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
fi

MCS_DIR="${MCS_DIR}" # Minecraft 服务端目录
MC_JAR="${MC_JAR}" # Minecraft 服务端 JAR 文件名
MC_JAR_PATH="$MCS_DIR/$MC_JAR" # JAR 文件完整路径
S3_ENDPOINT="${S3_ENDPOINT}" # S3 兼容存储服务 URL
S3_BUCKET="${S3_BUCKET}" # S3 存储桶名称
API_BASE="${API_BASE}" # API 基础 URL
AUTH_CREDENTIALS="${AUTH_CREDENTIALS}" # 认证信息
INSTANCE_DELETED=false

# 删除实例函数
terminate_instance() {
    if [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_DELETED" = false ]; then
        echo "[AUTO] 删除实例 $INSTANCE_ID..."
        curl -s -H "Authorization: Bearer $AUTH_CREDENTIALS" "$API_BASE/api/terminate-instance?instanceId=$INSTANCE_ID"
        echo "[AUTO] 实例删除请求已发送"
        INSTANCE_DELETED=true
    fi
}

# 错误处理函数
cleanup() {
    echo "[AUTO] 脚本出错或中断，执行清理..."
    terminate_instance
    exit 1
}

trap cleanup EXIT
trap cleanup ERR

IDLE_COUNT=0          # 空闲计数器
IDLE_THRESHOLD=5       # 连续 5 次无玩家触发自动关服（5 * 2 分钟 = 10 分钟）

# 动态获取 INSTANCE_ID
echo "[AUTO] 获取实例列表..."
INSTANCES_JSON=$(curl -s -H "Authorization: Bearer $AUTH_CREDENTIALS" "$API_BASE/api/instances")
SUCCESS=$(echo "$INSTANCES_JSON" | jq -r '.success')

if [ "$SUCCESS" != "true" ]; then
    echo "[AUTO] 获取实例列表失败，脚本退出"
    exit 1
fi

COUNT=$(echo "$INSTANCES_JSON" | jq -r '.count')

if [ "$COUNT" -eq 0 ]; then
    echo "[AUTO] 未找到任何实例，脚本退出"
    exit 1
elif [ "$COUNT" -gt 1 ]; then
    echo "[AUTO] 发现多个实例，脚本退出"
    exit 1
fi

INSTANCE_ID=$(echo "$INSTANCES_JSON" | jq -r '.instances[0].instanceId')
echo "[AUTO] 实例 ID = $INSTANCE_ID"

# 从实例列表中获取公网 IP
echo "[AUTO] 获取当前实例公网 IP..."
PUBLIC_IP=$(echo "$INSTANCES_JSON" | jq -r '.instances[0].publicIp')

if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" == "null" ]; then
    echo "[AUTO] 无法获取公网 IP，脚本退出"
    exit 1
fi

echo "[AUTO] 实例公网 IP = $PUBLIC_IP"
echo "[AUTO] 开始监听 Minecraft 玩家状态..."

while true; do
    sleep 120   # 每 2 分钟检测一次

    # 查询 Minecraft Server Status API
    STATUS_JSON=$(curl -s -A "Mozilla/5.0" "https://api.mcsrvstat.us/3/$PUBLIC_IP")
    ONLINE=$(echo "$STATUS_JSON" | jq -r '.online')
    PLAYERS=$(echo "$STATUS_JSON" | jq -r '.players.online // 0')

    if [ "$ONLINE" == "true" ] && [ "$PLAYERS" -gt 0 ]; then
        IDLE_COUNT=0
        echo "$(date) 玩家在线: $PLAYERS，重置空闲计数"
    else
        IDLE_COUNT=$((IDLE_COUNT+1))
        echo "$(date) 无玩家在线，空闲计数: $IDLE_COUNT/$IDLE_THRESHOLD"
    fi

    # 空闲超过阈值执行关服逻辑
    if [ "$IDLE_COUNT" -ge "$IDLE_THRESHOLD" ]; then
        echo "[AUTO] 连续 $IDLE_COUNT 次检测无玩家（共 $((IDLE_COUNT*2)) 分钟），开始自动关服..."

        # 关闭 Minecraft 服务端
        MC_PID=$(pgrep -f "$MC_JAR_PATH")
        if [ -n "$MC_PID" ]; then
            echo "[AUTO] 关闭 Minecraft 服务端 PID=$MC_PID"
            kill "$MC_PID"
            # 等待进程完全退出
            sleep 5
            if ps -p "$MC_PID" > /dev/null 2>&1; then
                echo "[AUTO] 强制杀掉未退出的服务端"
                kill -9 "$MC_PID"
            fi
        else
            echo "[AUTO] 未找到 Minecraft 服务端进程"
        fi
        sleep 5

        # 备份世界和配置文件
        cd "$MCS_DIR"
        rm -f world.zip
        zip -r world.zip world server.properties eula.txt ops.json whitelist.json banned-players.json banned-ips.json usercache.json 2>/dev/null || true

        # 上传到 S3
        aws s3 cp world.zip "s3://$S3_BUCKET/mc/world.zip" --endpoint-url "$S3_ENDPOINT"
        echo "[AUTO] world.zip 上传完成"

        # 调用 API 删除实例
        terminate_instance

        exit 0
    fi
done