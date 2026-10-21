import { createServer } from 'node:http';
import { exactKeys, UpdateError } from './release.mjs';

export function createUpdaterServer(manager) {
  const server = createServer(async (request, response) => {
    let status = 200, result;
    try {
      if (request.url === '/v1/status' && request.method === 'GET') result = manager.status();
      else if (['/v1/check', '/v1/apply'].includes(request.url) && request.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new UpdateError(415, '需要 JSON 请求');
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 2048) throw new UpdateError(413, '更新参数过大'); chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UpdateError(400, '无效的 JSON 更新参数'); }
        if (request.url === '/v1/check') {
          if (!exactKeys(body, [])) throw new UpdateError(400, '检查更新不接受自定义参数');
          result = await manager.check();
        } else { result = await manager.apply(body); status = 202; }
      } else throw new UpdateError(404, '更新操作不存在');
    } catch (error) { status = error instanceof UpdateError ? error.status : 503; result = { error: error instanceof UpdateError ? error.message : '受限更新器暂时不可用' }; }
    if (!response.headersSent) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 20;
  return server;
}
