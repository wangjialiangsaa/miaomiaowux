import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createGateway } from '../integration/server.mjs';

export async function startFixtures() {
  const secret = 'browser-fixture-secret-not-a-real-server-key';
  const state = { logins: 0, nodectlLogins: 0, protocols: [], imported: [], sessionValid: true, nodes: [{ uuid: 'fixture-server', install_id: 'fixture-install', name: '<img src=x onerror="window.fixtureXss=true">', routing_type: 1, agent_version: 'fixture', ipv4: '192.0.2.10', traffic_up: 1024, traffic_down: 2048, links: { vless_reality: 'vless://fixture@example.test:443#Fixture' }, disabled_links: [], tunnel_token: 'must-not-reach-browser', remark: '原有备注', traffic_limit: 123456, traffic_reset_mode: 'off', ip_mode: 1 }] };
  const json = (response, status, data) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
  const liveSockets = new Set();
  state.nodes[0].region = 'JP';
  state.liveConnections = 0; state.nodeReads = 0;
  state.sendTraffic = message => {
    const payload = Buffer.from(JSON.stringify(message));
    const header = payload.length < 126 ? Buffer.from([129, payload.length]) : Buffer.from([129, 126, payload.length >> 8, payload.length & 255]);
    for (const socket of liveSockets) socket.write(Buffer.concat([header, payload]));
  };
  const body = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); };
  const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
  const native = createServer(async (request, response) => {
    if (request.url === '/api/user/profile') return request.headers['mm-authorization'] === 'browser-fixture-session' && state.sessionValid ? json(response, 200, { username: 'fixture', role: 'admin', is_admin: true }) : json(response, 401, {});
    if (request.url === '/api/admin/nodes') return json(response, 200, { nodes: [{ id: 97, raw_url: 'unchanged-existing-link' }, ...state.imported] });
    if (request.url === '/fixture/login') {
      state.logins += 1;
      response.setHeader('set-cookie', 'traffic_info_access_token="browser-fixture-session"; Path=/; SameSite=Lax');
      return json(response, 200, {});
    }
    if (request.url === '/fixture/native-post') {
      const input = await body(request);
      if (input.route === '§46a7672619bac609') return json(response, 200, { data: { proxies: [{ type: 'vless', server: 'example.test', port: 443, name: 'Fixture node' }] } });
      if (input.route === '§a096b479adc7fa16') {
        const nodes = input.body.nodes.map((node, index) => ({ ...node, id: 100 + index })); state.imported.push(...nodes);
        return json(response, 200, { data: { nodes } });
      }
      return json(response, 404, {});
    }
    if (request.url === '/assets/index-fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      return response.end(`export const a={post:async(route,body)=>(await fetch('/fixture/native-post',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({route,body})})).json()}; document.querySelector('#fixture-login')?.addEventListener('submit',async event=>{event.preventDefault();await fetch('/fixture/login',{method:'POST'});location.href='/nodes';});document.querySelector('#fixture-logout')?.addEventListener('click',()=>{document.cookie='traffic_info_access_token=; path=/; max-age=0';});`);
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const loggedIn = request.headers.cookie?.includes('browser-fixture-session');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Unified fixture</title><style>body{font-family:system-ui;margin:0;display:flex}aside{width:180px;flex-shrink:0;padding:18px;background:#f1f4f7}main{min-width:0;flex:1}a{display:flex;padding:10px;color:inherit;text-decoration:none}*{box-sizing:border-box}@media(max-width:640px){body{display:block}aside{width:100%}}</style><script type="module" src="/assets/index-fixture.js"></script></head><body>${loggedIn ? '<aside><nav><ul data-sidebar="menu"><li><a href="/nodes">原节点管理</a></li></ul></nav><button id="fixture-logout">退出登录</button></aside><main><section id="native-content"><h1>原节点页面</h1><p>原有 97 个节点与订阅保持不变</p></section></main>' : '<main><form id="fixture-login"><label>用户名<input name="username"></label><label>密码<input name="password" type="password"></label><button>登录</button></form></main>'}</body></html>`);
  });
  const mmwxUrl = await listen(native);
  const nodectl = createServer(async (request, response) => {
    if (request.url === '/login') { state.nodectlLogins += 1; return json(response, 401, {}); }
    const token = request.headers.cookie?.replace('nodectl_token=', '') || '';
    const [header, claims, signature] = token.split('.');
    if (!claims || signature !== createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url')) return json(response, 401, {});
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).username, 'fixture-node-admin');
    if (request.url === '/api/get-nodes') { state.nodeReads += 1; return json(response, 200, { status: 'success', data: { direct_nodes: state.nodes, land_nodes: [] } }); }
    if (request.url?.startsWith('/api/traffic/consumption-rank?')) return json(response, 200, { status: 'success', rank: { generated_at: new URL(request.url, 'http://fixture').searchParams.get('date'), items: state.nodes.map(node => ({ uuid: node.uuid, name: node.name, traffic_up: 100, traffic_down: 200, offline: false })) } });
    const input = await body(request);
    if (request.url === '/api/update-node') state.nodes = state.nodes.map(node => node.uuid === input.uuid ? { ...input, remark: node.remark } : node);
    else if (request.url === '/api/add-node') state.nodes.push({ ...input, uuid: 'fixture-new', install_id: 'fixture-new-install', links: {}, disabled_links: [] });
    else if (request.url === '/api/delete-node') state.nodes = state.nodes.filter(node => node.uuid !== input.uuid);
    else if (request.url === '/api/callback/reset-protocol') {
      state.protocols.push(input);
      state.nodes[0].disabled_links = input.action === 'disable' ? input.protocols : [];
    } else return json(response, 404, {});
    return json(response, 200, { status: 'success', message: 'fixture complete' });
  });
  nodectl.on('upgrade', (request, socket) => {
    const signed = request.headers.cookie?.replace('nodectl_token=', '') || '';
    const [header, claims, signature] = signed.split('.');
    if (request.url !== '/api/traffic/live' || !claims || signature !== createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url')) return socket.destroy();
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    liveSockets.add(socket); state.liveConnections = liveSockets.size;
    socket.on('close', () => { liveSockets.delete(socket); state.liveConnections = liveSockets.size; });
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => { if ((chunk[0] & 15) === 8) socket.end(Buffer.from([136, 0])); });
  });
  const nodectlUrl = await listen(nodectl);
  const gateway = createGateway({ mmwxUrl, nodectlUrl, publicOrigin: 'http://127.0.0.1', credentials: () => ({ username: 'fixture-node-admin', secret, panelUrl: 'https://agent.example.test' }) });
  const base = await listen(gateway);
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
  const origin = new URL(base);
  const actualGateway = createGateway({ mmwxUrl, nodectlUrl, publicOrigin: origin.origin, credentials: () => ({ username: 'fixture-node-admin', secret, panelUrl: 'https://agent.example.test' }) });
  await new Promise(resolve => actualGateway.listen(Number(origin.port), '127.0.0.1', resolve));
  return { base, state, close: async () => { for (const socket of liveSockets) socket.destroy(); for (const server of [actualGateway, native, nodectl]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } } };
}
