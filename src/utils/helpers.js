const crypto = require('crypto');

// 辅助函数：获取真实客户端IP
function getClientIp(req) {
  // 优先从 X-Forwarded-For 获取（适用于反向代理）
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For 可能包含多个IP，第一个是客户端真实IP
    return forwarded.split(',')[0].trim();
  }
  // 其次从 X-Real-IP 获取（某些代理使用）
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return realIp;
  }
  // 最后使用 req.ip
  return req.ip || req.connection.remoteAddress || 'unknown';
}

// 生成UUID
function generateUUID() {
  return crypto.randomUUID();
}

module.exports = {
  getClientIp,
  generateUUID
};