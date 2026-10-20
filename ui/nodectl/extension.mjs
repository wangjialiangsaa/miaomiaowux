import { importMissingNodes } from './native-import.mjs';
import { createTrafficPanel, DISPLAY_INTERVAL_MS, trafficSnapshot } from './traffic.mjs';

const prefix = '/_nodectl';
const state = { authenticated: false, root: null, main: null, entries: new Map(), nodes: [], loading: false, cookie: null, checking: false, traffic: null, nodeMarkup: null };

function element(tag, attributes = {}, text) {
  const result = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') result.className = value;
    else result.setAttribute(key, value);
  }
  if (text !== undefined) result.textContent = text;
  return result;
}

function button(text, handler, className = '') {
  const result = element('button', { type: 'button', className: `nodectl-button ${className}` }, text);
  result.addEventListener('click', async () => {
    result.disabled = true;
    try { await handler(); }
    catch (error) { notice(error.message || '操作失败', true); }
    finally { result.disabled = false; }
  });
  return result;
}

function notice(message, error = false) {
  const target = state.root?.querySelector('[data-nodectl-notice]');
  if (target) { target.textContent = message; target.dataset.error = String(error); }
}

function revoke() {
  state.authenticated = false;
  for (const entry of state.entries.values()) entry.remove();
  state.entries.clear();
  closeWorkspace();
  state.root = null; state.nodes = []; state.traffic = null; state.nodeMarkup = null;
}

async function api(path, options = {}) {
  const response = await fetch(`${prefix}/api${path}`, {
    credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { ...(options.method ? { 'content-type': 'application/json', 'x-mmwx-nodectl': '1' } : {}), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if ([401, 403].includes(response.status)) revoke();
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '统一管理接口暂时不可用');
  return result;
}

function closeWorkspace() {
  stopTraffic();
  state.main?.classList.remove('nodectl-workspace-active');
  state.root?.remove();
}

function dialog(title, content) {
  const modal = element('dialog', { className: 'nodectl-dialog' });
  modal.append(element('h2', {}, title), content);
  const footer = element('div', { className: 'nodectl-actions' });
  footer.append(button('关闭', () => modal.close())); modal.append(footer);
  modal.addEventListener('close', () => modal.remove());
  document.body.append(modal); modal.showModal();
  return modal;
}

function showText(title, value) {
  const wrapper = element('div');
  const area = element('textarea', { readonly: '', rows: '8', 'aria-label': title }); area.value = value;
  wrapper.append(area, button('复制', async () => {
    try { await navigator.clipboard.writeText(value); }
    catch { area.focus(); area.select(); }
  }));
  dialog(title, wrapper);
}

function field(form, label, name, value, options) {
  const wrapper = element('label', {}, label);
  let input;
  if (options) {
    input = element('select', { name });
    for (const [choice, title] of options) input.append(element('option', { value: choice }, title));
  } else input = element('input', { name, maxlength: '128' });
  input.value = String(value ?? ''); wrapper.append(input); form.append(wrapper);
}

function edit(node) {
  const form = element('form', { className: 'nodectl-form' });
  field(form, '服务器名称', 'name', node?.name || '');
  field(form, '节点分组', 'routing_type', node?.routing_type || 1, [[1, '直连节点'], [2, '落地节点']]);
  if (node) {
    field(form, '地址模式', 'ip_mode', node.ip_mode || 0, [[0, '跟随系统'], [1, 'IPv4'], [2, 'IPv6'], [3, '双栈']]);
    field(form, '订阅可见性', 'is_blocked', String(Boolean(node.is_blocked)), [['false', '可用'], ['true', '屏蔽']]);
  }
  const status = element('p', { role: 'status', className: 'nodectl-muted' });
  const save = element('button', { type: 'submit', className: 'nodectl-button nodectl-primary' }, '保存');
  form.append(status, save);
  const modal = dialog(node ? '编辑服务器' : '添加服务器', form);
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true;
    const values = new FormData(form);
    const body = { name: values.get('name'), routing_type: Number(values.get('routing_type')) };
    if (node) Object.assign(body, { ip_mode: Number(values.get('ip_mode')), is_blocked: values.get('is_blocked') === 'true' });
    try {
      await api(node ? `/nodes/${encodeURIComponent(node.uuid)}` : '/nodes', { method: node ? 'PATCH' : 'POST', body });
      modal.close(); await refresh(); notice('服务器信息已保存');
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  });
}

function renderTraffic() {
  const traffic = state.traffic;
  if (!traffic || !state.root?.isConnected) return;
  traffic.panel.update(trafficSnapshot(state.nodes, traffic.samples, traffic.date ? traffic.rank || { items: [] } : null), { date: traffic.date, loading: traffic.loading, error: traffic.error, connected: traffic.socket?.readyState === WebSocket.OPEN });
}

async function loadTrafficDate(date) {
  const traffic = state.traffic;
  if (!traffic) return;
  const changed = traffic.date !== date;
  traffic.request?.abort(); traffic.date = date; traffic.error = false;
  if (changed) traffic.rank = null;
  if (!date) { traffic.rank = null; traffic.loading = false; renderTraffic(); return; }
  const controller = new AbortController(); traffic.request = controller;
  traffic.loading = !traffic.rank; renderTraffic();
  try {
    const result = await api('/traffic?' + new URLSearchParams({ date }), { signal: controller.signal });
    if (state.traffic === traffic && !controller.signal.aborted) traffic.rank = result.rank;
  } catch (error) {
    if (controller.signal.aborted) return;
    traffic.rank = null; traffic.error = true; notice(error.message, true);
  } finally {
    if (state.traffic === traffic && !controller.signal.aborted) { traffic.loading = false; traffic.request = null; renderTraffic(); }
  }
}

function connectTraffic() {
  const traffic = state.traffic;
  if (!traffic?.timer || traffic.socket || !state.authenticated || !state.root?.isConnected || document.visibilityState === 'hidden') return;
  const url = new URL(`${prefix}/api/traffic/live`, location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url); traffic.socket = socket;
  socket.onopen = () => { traffic.retry = 1000; renderTraffic(); };
  socket.onmessage = event => {
    try {
      const sample = JSON.parse(event.data);
      if (sample && state.nodes.some(node => node.uuid === sample.node_uuid)) traffic.samples.set(sample.node_uuid, { ...sample, receivedAt: Date.now() });
    } catch { }
  };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    if (traffic.socket !== socket) return;
    traffic.socket = null; renderTraffic();
    if (!traffic.timer) return;
    traffic.reconnect = setTimeout(async () => { await checkSession(); if (state.traffic === traffic) connectTraffic(); }, traffic.retry);
    traffic.retry = Math.min(15000, traffic.retry * 2);
  };
}

function startTraffic() {
  const traffic = state.traffic;
  if (!traffic || traffic.timer || document.visibilityState === 'hidden') return;
  traffic.timer = setInterval(() => { if (!document.querySelector('dialog[open]')) renderTraffic(); }, DISPLAY_INTERVAL_MS);
  connectTraffic();
}

function stopTraffic() {
  const traffic = state.traffic;
  if (!traffic) return;
  clearInterval(traffic.timer); clearTimeout(traffic.reconnect); traffic.timer = null;
  traffic.request?.abort(); traffic.request = null; traffic.loading = false;
  const socket = traffic.socket; traffic.socket = null;
  if (socket) { socket.onclose = null; socket.close(); }
}

async function protocol(node, name, action) {
  const label = { enable: '启用', disable: '停用', reset: '重置' }[action];
  if (!window.confirm(`${label} ${node.name} 的 ${name}？${action === 'reset' ? '这可能改变节点凭据，请随后更新订阅。' : ''}`)) return;
  await api(`/nodes/${encodeURIComponent(node.uuid)}/protocol`, { method: 'POST', body: { action, protocols: [name] } });
  notice('操作已提交，等待 Agent 执行和上报'); await refresh();
}

function renderNodes() {
  renderTraffic();
  const signature = JSON.stringify(state.nodes.map(({ traffic_up, traffic_down, traffic_update_at, traffic_history_count, ...node }) => node));
  if (signature === state.nodeMarkup) return;
  state.nodeMarkup = signature;
  const grid = state.root.querySelector('[data-nodectl-nodes]'); grid.replaceChildren();
  state.root.querySelector('[data-nodectl-count]').textContent = `${state.nodes.length} 台服务器`;
  if (!state.nodes.length) grid.append(element('p', { className: 'nodectl-empty' }, '暂无 NodeCTL 服务器。添加后生成 Agent 安装命令；不会改动原妙妙屋X节点。'));
  for (const node of state.nodes) {
    const card = element('article', { className: 'nodectl-card' });
    const heading = element('div', { className: 'nodectl-card-heading' });
    heading.append(element('h2', {}, node.name), element('span', { className: 'nodectl-badge' }, node.is_blocked ? '已屏蔽' : '可用'));
    card.append(heading, element('p', { className: 'nodectl-muted' }, [node.ipv4, node.ipv6].filter(Boolean).join(' · ') || '等待 Agent 上报地址'));
    card.append(element('p', { className: 'nodectl-muted' }, `Agent ${node.agent_version || '尚未注册'}`));
    if (node.remark) card.append(element('p', {}, node.remark));
    const controls = element('div', { className: 'nodectl-actions' });
    controls.append(button('编辑', () => edit(node)), button('Agent 安装命令', async () => showText('Agent 安装命令', (await api(`/nodes/${encodeURIComponent(node.uuid)}/install`)).command)), button('删除', async () => {
      if (!window.confirm(`删除 ${node.name}？NodeCTL可能同时清理关联 Agent 或隧道；此操作不能从本页面撤销。`)) return;
      await api(`/nodes/${encodeURIComponent(node.uuid)}`, { method: 'DELETE', body: {} }); await refresh();
    }, 'nodectl-danger'));
    card.append(controls);
    const protocols = element('div', { className: 'nodectl-protocols' });
    for (const name of Object.keys(node.links || {})) {
      const disabled = (node.disabled_links || []).includes(name);
      const row = element('div', { className: 'nodectl-protocol' });
      row.append(element('span', {}, name), element('span', { className: 'nodectl-muted' }, disabled ? '停用' : '启用'));
      row.append(button(disabled ? '启用' : '停用', () => protocol(node, name, disabled ? 'enable' : 'disable')), button('重置', () => protocol(node, name, 'reset')));
      protocols.append(row);
    }
    if (!protocols.childElementCount) protocols.append(element('p', { className: 'nodectl-muted' }, '等待 Agent 上报协议'));
    card.append(protocols); grid.append(card);
  }
}

async function refresh() {
  if (state.loading || !state.authenticated) return;
  state.loading = true;
  try {
    state.nodes = (await api('/nodes')).nodes;
    if (state.root?.isConnected) {
      for (const uuid of state.traffic.samples.keys()) if (!state.nodes.some(node => node.uuid === uuid)) state.traffic.samples.delete(uuid);
      renderNodes();
      if (state.traffic.date && !state.traffic.request) await loadTrafficDate(state.traffic.date);
    }
  }
  finally { state.loading = false; }
}

async function importNodes() {
  if (!window.confirm('仅新增妙妙屋X中缺少的已启用节点，不覆盖或删除已有节点。继续导入？')) return;
  const [exported, existing] = await Promise.all([api('/export'), api('/mmwx-nodes')]);
  const source = [...document.scripts].find(script => /\/assets\/index-[^/]+\.js(?:\?|$)/.test(script.src))?.src;
  if (!source || new URL(source).origin !== location.origin) throw new Error('无法定位妙妙屋X原生客户端；未导入节点');
  const native = await import(source);
  const result = await importMissingNodes(native.a, exported.entries, existing.nodes);
  notice(`已新增 ${result.imported} 个节点，跳过 ${result.skipped} 个已有或重复节点。切回原节点页面可查看。`);
}

function mountWorkspace() {
  if (!state.authenticated || location.hash !== '#nodectl') return closeWorkspace();
  const main = document.querySelector('main, [role="main"]');
  if (!main) return;
  state.main = main; main.classList.add('nodectl-workspace-active');
  if (!state.root) {
    state.root = element('section', { id: 'mmwx-nodectl-root', 'aria-label': 'NodeCTL 统一管理' });
    const header = element('header', { className: 'nodectl-header' });
    const title = element('div'); title.append(element('p', { className: 'nodectl-eyebrow' }, '服务器与 Agent'), element('h1', {}, 'NodeCTL 统一管理'), element('p', { className: 'nodectl-muted', 'data-nodectl-count': '' }));
    const actions = element('div', { className: 'nodectl-actions' });
    actions.append(button('返回原页面', () => { history.replaceState(null, '', location.pathname + location.search); closeWorkspace(); }), button('刷新', refresh), button('导出节点链接', async () => showText('已启用节点链接', (await api('/export')).entries.map(entry => entry.url).join('\n'))), button('导入到妙妙屋X', importNodes), button('添加服务器', () => edit(), 'nodectl-primary'));
    header.append(title, actions);
    const panel = createTrafficPanel(loadTrafficDate);
    state.traffic = { panel, samples: new Map(), date: null, rank: null, loading: false, error: false, request: null, timer: null, reconnect: null, socket: null, retry: 1000 };
    const layout = element('div', { className: 'nodectl-dashboard' });
    const management = element('section', { className: 'nodectl-management', 'aria-label': '服务器管理' });
    management.append(element('h2', { className: 'nodectl-management-title' }, '服务器管理'), element('div', { 'data-nodectl-nodes': '', className: 'nodectl-grid' }));
    layout.append(panel.root, management);
    state.root.append(header, element('p', { 'data-nodectl-notice': '', role: 'status', 'aria-live': 'polite', className: 'nodectl-notice' }, '沿用妙妙屋X管理员登录；原有节点和订阅保持独立，不自动覆盖。'), layout);
    renderNodes();
  }
  if (!state.root.isConnected) { main.append(state.root); startTraffic(); refresh().catch(error => notice(error.message, true)); }
}

function mountEntry() {
  if (!state.authenticated) return;
  mountWorkspace();
  const menu = document.querySelector('[data-sidebar="menu"], aside nav ul, nav[data-sidebar] ul');
  const containers = menu ? [menu] : [...document.querySelectorAll('nav')].filter(navigation => !navigation.closest('main, [role="main"], footer') && navigation.querySelector('a, button'));
  for (const [container, entry] of state.entries) {
    if (!containers.includes(container) || !entry.isConnected) { entry.remove(); state.entries.delete(container); }
  }
  for (const container of containers) {
    if (state.entries.has(container)) continue;
    const sidebar = container === menu;
    const template = container.querySelector('a, button');
    const entry = sidebar ? element('li', { 'data-sidebar': 'menu-item' }) : null;
    const link = element('a', { href: '#nodectl', 'data-nodectl-entry': '', 'aria-label': 'NodeCTL 服务器', title: 'NodeCTL 服务器', className: `${template?.className || 'nodectl-nav-link'}${sidebar ? '' : ' nodectl-top-nav-link'}` });
    if (sidebar) link.setAttribute('data-sidebar', 'menu-button');
    const icon = element('span', { 'aria-hidden': 'true' }, '▤');
    link.append(icon, element('span', { className: 'nodectl-nav-label' }, 'NodeCTL 服务器'));
    link.addEventListener('click', event => { event.preventDefault(); history.pushState(null, '', location.pathname + location.search + '#nodectl'); mountWorkspace(); });
    if (entry) entry.append(link);
    container.append(entry || link); state.entries.set(container, entry || link);
  }
}

async function checkSession() {
  if (state.checking) return;
  state.checking = true; state.cookie = document.cookie;
  try {
    if (!state.cookie.includes('traffic_info_access_token=')) return revoke();
    await api('/session'); state.authenticated = true; mountEntry();
  } catch { revoke(); }
  finally { state.checking = false; }
}

document.addEventListener('click', event => {
  const link = event.target.closest?.('a[href]');
  if (location.hash === '#nodectl' && link && !link.hasAttribute('data-nodectl-entry')) {
    history.replaceState(null, '', location.pathname + location.search); closeWorkspace();
  }
});
window.addEventListener('hashchange', mountWorkspace);
window.addEventListener('popstate', mountWorkspace);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopTraffic();
  else if (state.root?.isConnected) { startTraffic(); refresh().catch(error => notice(error.message, true)); }
});
new MutationObserver(mountEntry).observe(document.body, { childList: true, subtree: true });
setInterval(() => { if (document.cookie !== state.cookie) checkSession(); }, 1000);
setInterval(() => { if (state.root?.isConnected && document.visibilityState !== 'hidden' && !document.querySelector('dialog[open]')) refresh().catch(error => notice(error.message, true)); }, 15000);
checkSession();
