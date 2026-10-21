import { readFileSync } from 'node:fs';
import { createServer, request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { authenticate, checkMutation } from './auth.mjs';
import { NodeCtlClient, exportEntries, signNodeCtlToken, validateChanges } from './nodectl.mjs';
import { HttpError, requestJson, upstreamUrl } from './upstream.mjs';
import { updateRequest } from './updates.mjs';

const prefix = '/_nodectl';
const publicAgentPaths = new Set(['/api/public/new-install-script', '/api/public/download/agent', '/api/agent/init-config', '/api/callback/traffic/ws']);
const assets = new Map(['extension.mjs', 'native-import.mjs', 'traffic.mjs', 'updates.mjs', 'style.css'].map(name => [name, {
  body: readFileSync(new URL(`../ui/nodectl/${name}`, import.meta.url)), type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
}]));
const injection = '<link rel="stylesheet" href="/_nodectl/assets/style.css"><script type="module" data-mmwx-nodectl src="/_nodectl/assets/extension.mjs"></script>';
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function cleanHeaders(source) {
  const headers = { ...source };
  for (const field of [...hopHeaders, ...(source.connection || '').split(',').map(field => field.trim().toLowerCase())]) delete headers[field];
  return headers;
}

function sendJson(response, status, payload) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 262144) throw new HttpError(413, '请求体超过 256 KiB 限制');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, '无效的 JSON 请求'); }
}

function proxy(request, response, config, agent = false) {
  const target = new URL(request.url, agent ? config.nodectlUrl : config.mmwxUrl);
  if (target.origin !== (agent ? config.nodectlUrl : config.mmwxUrl)) throw new HttpError(400, '无效的请求地址');
  const headers = cleanHeaders(request.headers);
  headers.host = new URL(config.publicOrigin).host;
  headers['x-forwarded-host'] = headers.host;
  headers['x-forwarded-proto'] = new URL(config.publicOrigin).protocol.slice(0, -1);
  headers['x-forwarded-for'] = request.socket.remoteAddress;
  headers['accept-encoding'] = 'identity';
  if (agent) { delete headers.cookie; delete headers['mm-authorization']; }
  if (request.headers.accept?.includes('text/html') || target.pathname === '/') {
    delete headers['if-none-match']; delete headers['if-modified-since'];
  }
  const upstream = (target.protocol === 'https:' ? requestHttps : requestHttp)(target, { method: request.method, headers }, incoming => {
    const outgoingHeaders = cleanHeaders(incoming.headers);
    if (agent) delete outgoingHeaders['set-cookie'];
    const instrument = !agent && request.method === 'GET' && incoming.statusCode === 200 && /\btext\/html\b/i.test(incoming.headers['content-type'] || '');
    if (!instrument) {
      response.writeHead(incoming.statusCode, outgoingHeaders);
      incoming.pipe(response);
      return;
    }
    const chunks = [];
    let size = 0;
    incoming.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) incoming.destroy(new Error('HTML too large'));
      else chunks.push(chunk);
    });
    incoming.on('end', () => {
      try {
        let buffer = Buffer.concat(chunks);
        const encoding = (incoming.headers['content-encoding'] || 'identity').toLowerCase();
        const decompress = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
        if (decompress) buffer = decompress(buffer, { maxOutputLength: 2 * 1024 * 1024 });
        else if (encoding !== 'identity') throw new Error('Unsupported HTML encoding');
        let html = buffer.toString('utf8');
        if (!html.includes('data-mmwx-nodectl')) html = html.includes('</head>') ? html.replace('</head>', injection + '</head>') : injection + html;
        for (const field of ['content-length', 'content-encoding', 'etag', 'last-modified', 'content-md5', 'digest']) delete outgoingHeaders[field];
        outgoingHeaders['cache-control'] = 'no-store';
        response.writeHead(incoming.statusCode, outgoingHeaders);
        response.end(html);
      } catch { sendJson(response, 502, { error: '无法安全处理原面板 HTML' }); }
    });
    incoming.on('error', () => sendJson(response, 502, { error: '原面板响应中断' }));
  });
  upstream.setTimeout(config.timeoutMs, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => sendJson(response, 502, { error: '原服务暂时不可用' }));
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
}

function proxyUpgrade(request, socket, head, config, agent, managementToken) {
  const nodeCtl = agent || Boolean(managementToken);
  const target = new URL(managementToken ? '/api/traffic/live' : request.url, nodeCtl ? config.nodectlUrl : config.mmwxUrl);
  if (target.origin !== (nodeCtl ? config.nodectlUrl : config.mmwxUrl)) return socket.destroy();
  const headers = cleanHeaders(request.headers);
  headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
  headers.host = new URL(config.publicOrigin).host;
  headers['x-forwarded-proto'] = new URL(config.publicOrigin).protocol.slice(0, -1);
  if (nodeCtl) { delete headers.cookie; delete headers['mm-authorization']; }
  if (managementToken) {
    headers.cookie = `nodectl_token=${managementToken}`;
    const expiry = setTimeout(() => socket.destroy(), 55000);
    expiry.unref(); socket.once('close', () => clearTimeout(expiry));
  }
  const upstream = (target.protocol === 'https:' ? requestHttps : requestHttp)(target, { headers });
  upstream.on('upgrade', (response, remote, remoteHead) => {
    remote.setTimeout(0);
    const responseHeaders = Object.entries(response.headers).filter(([name]) => !nodeCtl || name !== 'set-cookie').flatMap(([name, value]) => Array.isArray(value) ? value.map(entry => `${name}: ${entry}`) : [`${name}: ${value}`]);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
    if (head.length) remote.write(head);
    if (remoteHead.length) socket.write(remoteHead);
    socket.pipe(remote).pipe(socket);
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    socket.on('end', () => remote.destroy()); remote.on('end', () => socket.destroy());
    socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
  });
  upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); });
  upstream.setTimeout(config.timeoutMs, () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.end();
}

export function createGateway(options) {
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only on localhost)');
  const config = { ...options, mmwxUrl: upstreamUrl(options.mmwxUrl), nodectlUrl: upstreamUrl(options.nodectlUrl), timeoutMs: options.timeoutMs || 10000 };
  const client = new NodeCtlClient(config);
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) throw new HttpError(400, '无效的请求路径');
      const path = new URL(request.url, config.publicOrigin).pathname;
      if (path === `${prefix}/health` && request.method === 'GET') return sendJson(response, 200, { ok: true, version: config.buildVersion || '0.0.0', revision: config.buildRevision || 'development' });
      if (path.startsWith(`${prefix}/assets/`) && ['GET', 'HEAD'].includes(request.method)) {
        const asset = assets.get(path.slice(`${prefix}/assets/`.length));
        if (!asset) throw new HttpError(404, '资源不存在');
        response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        return response.end(request.method === 'HEAD' ? undefined : asset.body);
      }
      if (!path.startsWith(prefix + '/') && path !== prefix) return proxy(request, response, config, publicAgentPaths.has(path));
      if (!path.startsWith(prefix + '/api/')) throw new HttpError(404, '集成接口不存在');
      const session = await authenticate(request, config);
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) throw new HttpError(405, '不支持的管理方法');
      if (request.method !== 'GET') checkMutation(request, config);
      if (path === `${prefix}/api/session` && request.method === 'GET') return sendJson(response, 200, { username: session.username, role: session.role });
      const update = path.match(/^\/_nodectl\/api\/updates\/(status|check|apply)$/);
      if (update && request.method === (update[1] === 'status' ? 'GET' : 'POST')) return sendJson(response, update[1] === 'apply' ? 202 : 200, await updateRequest(config.updaterSocket, update[1], update[1] === 'status' ? undefined : await readJson(request)));
      if (path === `${prefix}/api/traffic` && request.method === 'GET') return sendJson(response, 200, await client.traffic(new URL(request.url, config.publicOrigin).searchParams.get('date')));
      if (path === `${prefix}/api/mmwx-nodes` && request.method === 'GET') {
        const result = await requestJson(config.mmwxUrl, '/api/admin/nodes', { headers: { 'MM-Authorization': session.token }, timeoutMs: config.timeoutMs });
        if (result.status !== 200 || !Array.isArray(result.data?.nodes)) throw new HttpError(502, '妙妙屋X节点接口不兼容');
        return sendJson(response, 200, result.data);
      }
      if (path === `${prefix}/api/export` && request.method === 'GET') return sendJson(response, 200, { entries: exportEntries(await client.nodes()) });
      if (path === `${prefix}/api/nodes`) {
        if (request.method === 'GET') return sendJson(response, 200, { nodes: (await client.nodes()).map(({ tunnel_token, ...node }) => node) });
        if (request.method === 'POST') {
          const body = await readJson(request); validateChanges(body, true);
          return sendJson(response, 200, await client.request('/api/add-node', { name: body.name.trim(), routing_type: body.routing_type ?? 1 }));
        }
      }
      const match = path.match(/^\/_nodectl\/api\/nodes\/([A-Za-z0-9_-]{1,128})(?:\/(install|protocol))?$/);
      if (match) {
        const [, uuid, action] = match;
        if (action === 'install' && request.method === 'GET') return sendJson(response, 200, await client.install(uuid));
        if (action === 'protocol' && request.method === 'POST') return sendJson(response, 200, await client.protocol(uuid, await readJson(request)));
        if (!action && request.method === 'PATCH') return sendJson(response, 200, await client.update(uuid, await readJson(request)));
        if (!action && request.method === 'DELETE') {
          await readJson(request); await client.node(uuid);
          return sendJson(response, 200, await client.request('/api/delete-node', { uuid }));
        }
      }
      throw new HttpError(404, '集成接口不存在');
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.message : '统一管理服务暂时不可用' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxHeadersCount = 100;
  server.on('upgrade', async (request, socket, head) => {
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) return socket.destroy();
    const path = new URL(request.url, config.publicOrigin).pathname;
    if (path === `${prefix}/api/traffic/live`) {
      try {
        if (request.headers.origin !== config.publicOrigin) throw new HttpError(403, '无效的实时连接来源');
        await authenticate(request, config);
        if (!socket.destroyed) proxyUpgrade(request, socket, head, config, false, signNodeCtlToken(client.credentials()));
      } catch (error) {
        socket.end(`HTTP/1.1 ${error instanceof HttpError ? error.status : 503} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
      return;
    }
    if (path === prefix || path.startsWith(prefix + '/')) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    proxyUpgrade(request, socket, head, config, path === '/api/callback/traffic/ws');
  });
  return server;
}
