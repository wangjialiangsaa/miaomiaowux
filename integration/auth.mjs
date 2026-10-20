import { HttpError, requestJson } from './upstream.mjs';

export function parseSessionCookie(header = '') {
  if (typeof header !== 'string' || header.length > 16384) return '';
  const values = header.split(';').map(value => value.trim()).filter(value => value.startsWith('traffic_info_access_token='));
  if (values.length !== 1) return '';
  try {
    const token = JSON.parse(decodeURIComponent(values[0].slice('traffic_info_access_token='.length)));
    return typeof token === 'string' && token.length > 0 && token.length <= 8192 && !/[\r\n\x00-\x20\x7f]/.test(token) ? token : '';
  } catch { return ''; }
}

export async function authenticate(request, config) {
  const token = parseSessionCookie(request.headers.cookie);
  if (!token) throw new HttpError(401, '请先登录妙妙屋X');
  const result = await requestJson(config.mmwxUrl, '/api/user/profile', {
    headers: { 'MM-Authorization': token }, maxBytes: 65536, timeoutMs: config.timeoutMs,
  });
  if ([401, 403].includes(result.status)) throw new HttpError(401, '妙妙屋X登录已失效');
  if (result.status !== 200) throw new HttpError(503, '无法校验妙妙屋X登录状态');
  if (result.data?.role !== 'admin' || result.data?.is_admin !== true) throw new HttpError(403, '仅妙妙屋X管理员可管理 NodeCTL');
  return { token, username: result.data.username, role: 'admin' };
}

export function checkMutation(request, config) {
  if (request.headers.origin !== config.publicOrigin || request.headers['x-mmwx-nodectl'] !== '1' || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, '拒绝非同源管理请求');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new HttpError(415, '管理请求必须使用 JSON');
}
