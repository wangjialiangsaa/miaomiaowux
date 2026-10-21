const phaseLabels = { preflight: '检查磁盘、网关和原业务服务', download: '下载并校验已签名镜像', backup: '备份原数据、配置和旧版网关', load: '载入并核对镜像身份', deploy: '替换整合网关，短暂重连属于正常现象', health: '验证新版网关和原业务服务', 'rolling-back': '新版检查未通过，正在恢复旧版', succeeded: '更新已完成，健康检查通过；可刷新页面使用新版', 'rolled-back': '更新未完成，已自动恢复旧版网关', failed: '更新未进入部署阶段，原网关继续运行', 'manual-required': '自动回退未通过检查，请联系管理员人工处理' };
const phases = ['preflight', 'download', 'backup', 'load', 'deploy', 'health'];

export function createUpdateDialog({ api, element, onClose }) {
  const modal = element('dialog', { className: 'nodectl-dialog nodectl-update', 'aria-labelledby': 'nodectl-update-title' });
  const title = element('h2', { id: 'nodectl-update-title' }, '系统更新');
  const description = element('p', { className: 'nodectl-muted' }, '仅更新整合网关与管理界面，不升级妙妙屋X、NodeCTL 引擎或 Agent，不覆盖节点、账号和订阅。');
  const versions = element('dl', { className: 'nodectl-update-versions' });
  const current = element('dd', { 'data-update-current': '' }, '读取中…');
  const latest = element('dd', { 'data-update-latest': '' }, '尚未检查');
  const checked = element('dd', {}, '—');
  versions.append(element('dt', {}, '当前网关'), current, element('dt', {}, '最新稳定版'), latest, element('dt', {}, '最近检查'), checked);
  const message = element('p', { role: 'status', 'aria-live': 'polite', 'data-update-status': '', className: 'nodectl-update-status' }, '正在读取更新器状态…');
  const progress = element('progress', { max: '6', value: '0', 'aria-label': '更新阶段进度', hidden: '' });
  const notes = element('pre', { 'data-update-notes': '', className: 'nodectl-update-notes' }, '检查更新后显示发布说明。');
  const actions = element('div', { className: 'nodectl-actions' });
  const check = element('button', { type: 'button', className: 'nodectl-button' }, '检查更新');
  const apply = element('button', { type: 'button', className: 'nodectl-button nodectl-primary' }, '确认更新');
  const reload = element('button', { type: 'button', className: 'nodectl-button nodectl-primary', hidden: '' }, '刷新页面');
  const closeButton = element('button', { type: 'button', className: 'nodectl-button' }, '关闭');
  actions.append(check, apply, reload, closeButton);
  modal.append(title, description, versions, message, progress, element('h3', {}, '发布说明'), notes, element('p', { className: 'nodectl-muted' }, '更新前自动备份，健康检查失败自动回退。关闭弹窗不会中断已提交的更新。'), actions);
  let status = null, error = null, disconnected = false, pending = false, closed = false, timer = null, controller = null;
  const text = (target, value) => { if (target.textContent !== value) target.textContent = value; };
  function render() {
    if (closed) return;
    text(current, status?.current?.version || (error ? '暂时无法读取' : '读取中…'));
    text(latest, status?.latest?.version || '尚未检查');
    text(checked, status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : '—');
    text(notes, status?.latest?.notes || '检查更新后显示发布说明。');
    text(message, error || (!status?.enabled ? status?.reason || '正在连接受限更新器…' : status.job?.error || phaseLabels[status.job?.phase] || status.checkError || (status.available ? '发现新版本，请阅读说明后确认更新。' : status.latest ? '当前已是最新稳定版。' : '检查已签名的稳定发布，不会自动安装。')));
    message.dataset.error = String(Boolean(error || status?.blocked || ['failed', 'rolled-back'].includes(status?.job?.phase)));
    check.disabled = pending || disconnected || !status?.enabled || status.busy;
    apply.disabled = check.disabled || !status?.available || status?.blocked;
    reload.hidden = status?.job?.phase !== 'succeeded';
    apply.hidden = !reload.hidden;
    progress.hidden = !status?.busy;
    progress.value = Math.max(0, phases.indexOf(status?.job?.phase)) + 1;
  }
  function schedule() {
    clearTimeout(timer);
    if (!closed && modal.open && document.visibilityState !== 'hidden') timer = setTimeout(() => request('status'), 2000);
  }
  async function request(action) {
    if (closed || pending || document.visibilityState === 'hidden') return;
    if (action === 'apply' && (!status?.available || !window.confirm(`确认将整合网关更新到 ${status.latest.version}？\n仅替换网关，原节点、账号、订阅和两个业务引擎保持不变；期间页面可能短暂重连。`))) return;
    clearTimeout(timer); pending = true; controller = new AbortController(); render();
    try {
      const result = await api(`/updates/${action}`, { signal: controller.signal, ...(action === 'status' ? {} : { method: 'POST', body: action === 'check' ? {} : { version: status.latest.version, manifestSha256: status.latest.manifestSha256 } }) });
      if (!closed) { status = result; error = null; disconnected = false; }
    } catch (failure) {
      if (!controller?.signal.aborted && !closed) {
        disconnected = action === 'status';
        error = disconnected ? '连接暂时中断，正在等待网关或更新器恢复；请勿重复提交更新。' : failure.message || '更新操作未完成，请重新检查状态。';
        if (action === 'check' && status) status.available = false;
      }
    } finally { pending = false; controller = null; render(); schedule(); }
  }
  function cleanup() {
    if (closed) return;
    closed = true; clearTimeout(timer); controller?.abort();
    document.removeEventListener('visibilitychange', visibility);
    modal.remove(); onClose?.();
  }
  function visibility() {
    if (document.visibilityState === 'hidden') { clearTimeout(timer); controller?.abort(); }
    else request('status');
  }
  check.addEventListener('click', () => request('check'));
  apply.addEventListener('click', () => request('apply'));
  reload.addEventListener('click', () => location.reload());
  closeButton.addEventListener('click', () => modal.close());
  modal.addEventListener('close', cleanup);
  document.addEventListener('visibilitychange', visibility);
  document.body.append(modal); modal.showModal(); render(); request('status');
  return { close() { if (modal.open) modal.close(); cleanup(); } };
}
