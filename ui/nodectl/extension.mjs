import { importMissingNodes } from './native-import.mjs';

const prefix = '/_nodectl';
const state = { authenticated: false, root: null, main: null, entry: null, nodes: [], loading: false, cookie: null, checking: false };

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
  state.entry?.remove(); state.entry = null;
  closeWorkspace();
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

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const exponent = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][exponent]}`;
}

async function protocol(node, name, action) {
  const label = { enable: '启用', disable: '停用', reset: '重置' }[action];
  if (!window.confirm(`${label} ${node.name} 的 ${name}？${action === 'reset' ? '这可能改变节点凭据，请随后更新订阅。' : ''}`)) return;
  await api(`/nodes/${encodeURIComponent(node.uuid)}/protocol`, { method: 'POST', body: { action, protocols: [name] } });
  notice('操作已提交，等待 Agent 执行和上报'); await refresh();
}

function renderNodes() {
  const grid = state.root.querySelector('[data-nodectl-nodes]'); grid.replaceChildren();
  state.root.querySelector('[data-nodectl-count]').textContent = `${state.nodes.length} 台服务器`;
  if (!state.nodes.length) grid.append(element('p', { className: 'nodectl-empty' }, '暂无 NodeCTL 服务器。添加后生成 Agent 安装命令；不会改动原妙妙屋X节点。'));
  for (const node of state.nodes) {
    const card = element('article', { className: 'nodectl-card' });
    const heading = element('div', { className: 'nodectl-card-heading' });
    heading.append(element('h2', {}, node.name), element('span', { className: 'nodectl-badge' }, node.is_blocked ? '已屏蔽' : '可用'));
    card.append(heading, element('p', { className: 'nodectl-muted' }, [node.ipv4, node.ipv6].filter(Boolean).join(' · ') || '等待 Agent 上报地址'));
    card.append(element('p', { className: 'nodectl-muted' }, `Agent ${node.agent_version || '尚未注册'} · 上传 ${formatBytes(node.traffic_up)} · 下载 ${formatBytes(node.traffic_down)}`));
    if (node.traffic_update_at) card.append(element('p', { className: 'nodectl-muted' }, `最近上报：${node.traffic_update_at}`));
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
  try { state.nodes = (await api('/nodes')).nodes; if (state.root?.isConnected) renderNodes(); }
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
    state.root.append(header, element('p', { 'data-nodectl-notice': '', role: 'status', 'aria-live': 'polite', className: 'nodectl-notice' }, '沿用妙妙屋X管理员登录；原有节点和订阅保持独立，不自动覆盖。'), element('div', { 'data-nodectl-nodes': '', className: 'nodectl-grid' }));
    renderNodes();
  }
  if (!state.root.isConnected) { main.append(state.root); refresh().catch(error => notice(error.message, true)); }
}

function mountEntry() {
  if (!state.authenticated) return;
  const menu = document.querySelector('[data-sidebar="menu"], aside nav ul, nav[data-sidebar] ul');
  if (!menu) return;
  if (!state.entry?.isConnected) {
    const template = menu.querySelector('a');
    const entry = element('li', { 'data-sidebar': 'menu-item' });
    const link = element('a', { href: '#nodectl', 'data-sidebar': 'menu-button', 'data-nodectl-entry': '', className: template?.className || 'nodectl-nav-link' });
    const icon = element('span', { 'aria-hidden': 'true' }, '▤');
    link.append(icon, element('span', {}, 'NodeCTL 服务器'));
    link.addEventListener('click', event => { event.preventDefault(); history.pushState(null, '', location.pathname + location.search + '#nodectl'); mountWorkspace(); });
    entry.append(link); menu.append(entry); state.entry = entry;
  }
  mountWorkspace();
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
new MutationObserver(mountEntry).observe(document.body, { childList: true, subtree: true });
setInterval(() => { if (document.cookie !== state.cookie) checkSession(); }, 1000);
setInterval(() => { if (state.root?.isConnected && document.visibilityState !== 'hidden' && !document.querySelector('dialog[open]')) refresh().catch(error => notice(error.message, true)); }, 15000);
checkSession();
