import { request } from 'node:http';
import { HttpError } from './upstream.mjs';

export async function updateRequest(socketPath, action, body) {
  if (!['status', 'check', 'apply'].includes(action)) throw new HttpError(400, '不支持的更新操作');
  if (action !== 'status') {
    const keys = action === 'check' ? [] : ['version', 'manifestSha256'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length || !keys.every(key => Object.hasOwn(body, key)) || (action === 'apply' && (typeof body.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(body.version) || typeof body.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.manifestSha256)))) throw new HttpError(400, '更新参数不符合要求');
  }
  if (!socketPath) {
    if (action === 'status') return { enabled: false, reason: '尚未启用受限更新器，请管理员按部署文档配置；现有功能不受影响' };
    throw new HttpError(503, '尚未启用受限更新器');
  }
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path: `/v1/${action}`, method: action === 'status' ? 'GET' : 'POST', headers: { host: 'updater', 'content-type': 'application/json' }, timeout: action === 'check' ? 45000 : 10000 }, incoming => {
      const chunks = []; let size = 0;
      incoming.on('data', chunk => { size += chunk.length; if (size > 65536) incoming.destroy(new Error('Large updater response')); else chunks.push(chunk); });
      incoming.on('error', () => reject(new HttpError(503, '更新器连接中断，请稍后重试')));
      incoming.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (incoming.statusCode < 200 || incoming.statusCode >= 300) return reject(new HttpError([400, 404, 409, 413, 415, 422, 429].includes(incoming.statusCode) ? incoming.statusCode : 503, typeof data.error === 'string' ? data.error.slice(0, 300) : '更新器暂时不可用'));
          resolve(data);
        } catch { reject(new HttpError(503, '更新器返回了无效状态')); }
      });
    });
    outgoing.on('timeout', () => outgoing.destroy());
    outgoing.on('error', () => reject(new HttpError(503, '更新器暂时无法连接；更新期间请稍后重试')));
    outgoing.end(action === 'status' ? undefined : JSON.stringify(body));
  });
}
