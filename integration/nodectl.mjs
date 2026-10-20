import { createHmac } from 'node:crypto';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HttpError, requestJson } from './upstream.mjs';

export function readNodeCtlCredentials(path) {
  if (!path || !statSync(path).isFile()) throw new Error('NodeCTL SQLite database is unavailable');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000');
    const settings = Object.fromEntries(database.prepare("SELECT key, value FROM sys_config WHERE key IN ('jwt_secret', 'admin_username', 'panel_url')").all().map(row => [row.key, row.value]));
    if (!settings.jwt_secret || !settings.admin_username) throw new Error('NodeCTL authentication settings are incomplete');
    return { secret: settings.jwt_secret, username: settings.admin_username, panelUrl: settings.panel_url || '' };
  } finally { database.close(); }
}

export function signNodeCtlToken(credentials, timestamp = Math.floor(Date.now() / 1000)) {
  if (!credentials?.secret || !credentials?.username) throw new HttpError(503, 'NodeCTL单点登录配置不可用');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ username: credentials.username, iat: timestamp, exp: timestamp + 60 })).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${createHmac('sha256', credentials.secret).update(signed).digest('base64url')}`;
}

export class NodeCtlClient {
  constructor(config) { this.config = config; }

  credentials() {
    try { return this.config.credentials(); }
    catch { throw new HttpError(503, '无法只读访问 NodeCTL 登录配置；请检查数据库挂载和权限'); }
  }

  async request(path, body) {
    const token = signNodeCtlToken(this.credentials());
    const result = await requestJson(this.config.nodectlUrl, path, {
      method: body === undefined ? 'GET' : 'POST', body, timeoutMs: this.config.timeoutMs,
      headers: { cookie: `nodectl_token=${token}`, 'content-type': 'application/json', 'x-forwarded-proto': new URL(this.config.publicOrigin).protocol.slice(0, -1) },
    });
    if (result.status !== 200 || result.data?.status !== 'success') throw new HttpError(502, 'NodeCTL操作失败；请检查上游状态和版本兼容性');
    return result.data;
  }

  async nodes() {
    const payload = await this.request('/api/get-nodes');
    if (Array.isArray(payload.data?.direct_nodes) && Array.isArray(payload.data?.land_nodes)) return [...payload.data.direct_nodes, ...payload.data.land_nodes];
    throw new HttpError(502, 'NodeCTL节点接口不兼容');
  }

  async node(uuid) {
    const node = (await this.nodes()).find(node => node.uuid === uuid);
    if (!node) throw new HttpError(404, 'NodeCTL服务器不存在');
    return node;
  }

  async update(uuid, changes) {
    validateChanges(changes);
    const current = await this.node(uuid);
    const merged = { ...current, ...changes, uuid };
    if (current.traffic_reset_anchor_at) merged.traffic_reset_anchor_date = current.traffic_reset_anchor_at.slice(0, 10);
    return this.request('/api/update-node', merged);
  }

  async protocol(uuid, body) {
    const node = await this.node(uuid);
    if (!body || !['enable', 'disable', 'reset'].includes(body.action) || !Array.isArray(body.protocols) || !body.protocols.length || body.protocols.length > 32 || body.protocols.some(protocol => typeof protocol !== 'string' || !Object.hasOwn(node.links || {}, protocol))) {
      throw new HttpError(400, '无效的协议操作');
    }
    return this.request('/api/callback/reset-protocol', { install_id: node.install_id, action: body.action, protocols: [...new Set(body.protocols)] });
  }

  async install(uuid) {
    const node = await this.node(uuid);
    if (!node.install_id) throw new HttpError(409, 'NodeCTL未生成该服务器的安装标识');
    const origin = new URL(this.credentials().panelUrl || this.config.publicOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new HttpError(503, 'NodeCTL Agent地址配置无效');
    const url = new URL(origin.toString().replace(/\/$/, '') + '/api/public/new-install-script');
    url.searchParams.set('id', node.install_id);
    const quoted = `'${url.toString().replaceAll("'", "'\"'\"'")}'`;
    return { command: `bash -c "$(curl -fsSL ${quoted})"`, agentOrigin: origin.origin };
  }
}

export function validateChanges(body, creating = false) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new HttpError(400, '服务器信息必须是 JSON 对象');
  const allowed = creating ? ['name', 'routing_type'] : ['name', 'is_blocked', 'ip_mode', 'routing_type'];
  if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, '包含不允许修改的字段');
  if ((creating || Object.hasOwn(body, 'name')) && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 128)) throw new HttpError(400, '服务器名称须为 1–128 个字符');
  if (Object.hasOwn(body, 'is_blocked') && typeof body.is_blocked !== 'boolean') throw new HttpError(400, '屏蔽状态必须为布尔值');
  for (const [field, minimum, maximum] of [['ip_mode', 0, 3], ['routing_type', 1, 2]]) if (Object.hasOwn(body, field) && (!Number.isInteger(body[field]) || body[field] < minimum || body[field] > maximum)) throw new HttpError(400, '服务器选项无效');
}

export function exportEntries(nodes) {
  const entries = [];
  for (const node of nodes) {
    if (node.is_blocked) continue;
    for (const [protocol, url] of Object.entries(node.links || {})) {
      if ((node.disabled_links || []).includes(protocol) || typeof url !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /[\r\n]/.test(url)) continue;
      entries.push({ uuid: node.uuid, server: node.name, protocol, url });
    }
  }
  return entries;
}
