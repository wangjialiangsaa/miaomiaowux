export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function upstreamUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Upstream URLs must be HTTP(S) origins without credentials or paths');
  }
  return url.origin;
}

export async function requestJson(origin, path, options = {}) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs || 10000),
      redirect: 'manual',
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > (options.maxBytes || 8 * 1024 * 1024)) throw new HttpError(502, '上游响应超过限制');
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(502, '上游接口不兼容：未返回 JSON'); }
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, '上游服务暂时不可用');
  }
}
