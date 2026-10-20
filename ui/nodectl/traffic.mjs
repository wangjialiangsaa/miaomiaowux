export const DISPLAY_INTERVAL_MS = 500;
export const LIVE_STALE_MS = 15000;

function counter(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

export function formatTraffic(value, rate = false) {
  if (value === null || value === undefined) return '—';
  const bytes = counter(value);
  const exponent = bytes > 0 ? Math.min(4, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024)))) : 0;
  return `${(bytes / 1024 ** exponent).toLocaleString('en-US', { maximumFractionDigits: exponent ? 2 : 0 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][exponent]}${rate ? '/s' : ''}`;
}

export function regionFlag(region) {
  const code = String(region || '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map(letter => 127397 + letter.charCodeAt(0))) : '';
}

export function trafficSnapshot(nodes, samples = new Map(), rank = null, now = Date.now()) {
  const sources = rank ? rank.items || [] : nodes;
  const servers = new Map(nodes.map(node => [node.uuid, node]));
  const rows = sources.map(item => {
    const node = servers.get(item.uuid) || item;
    const sample = samples.get(item.uuid);
    const fresh = Boolean(sample && now >= sample.receivedAt && now - sample.receivedAt <= LIVE_STALE_MS);
    const online = fresh && !sample.offline;
    const totalAvailable = fresh && Number.isFinite(sample.total_tx_bytes) && Number.isFinite(sample.total_rx_bytes);
    const up = counter(!rank && totalAvailable ? sample.total_tx_bytes : item.traffic_up);
    const down = counter(!rank && totalAvailable ? sample.total_rx_bytes : item.traffic_down);
    return {
      uuid: item.uuid, name: node.name || item.name || item.uuid, region: node.region || item.region || '', up, down, total: up + down,
      status: fresh ? (online ? 'online' : 'offline') : (sample ? 'stale' : item.offline ? 'offline' : 'pending'),
      upRate: online && Number.isFinite(sample.tx_rate_bps) ? counter(sample.tx_rate_bps) : null,
      downRate: online && Number.isFinite(sample.rx_rate_bps) ? counter(sample.rx_rate_bps) : null,
      ratio: up > 0 ? (down / up).toFixed(2) : '—',
    };
  }).sort((first, second) => second.total - first.total || String(first.uuid).localeCompare(String(second.uuid)));
  return { rows, up: rows.reduce((total, row) => total + row.up, 0), down: rows.reduce((total, row) => total + row.down, 0), total: rows.reduce((total, row) => total + row.total, 0), maximum: Math.max(1, ...rows.map(row => row.total)) };
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function text(target, value) {
  if (target.textContent !== value) target.textContent = value;
}

function trafficRow() {
  const root = node('article', 'nodectl-traffic-row');
  root.dataset.trafficRow = '';
  const heading = node('div', 'nodectl-traffic-row-heading');
  const name = node('div', 'nodectl-traffic-server');
  const flag = node('span', 'nodectl-traffic-flag'); flag.setAttribute('aria-hidden', 'true');
  const label = node('strong');
  const status = node('span', 'nodectl-traffic-dot');
  const total = node('strong', 'nodectl-traffic-total');
  name.append(flag, label, status); heading.append(name, total);
  const track = node('div', 'nodectl-traffic-track'); track.setAttribute('role', 'img');
  const fill = node('div', 'nodectl-traffic-fill');
  const uploadBar = node('span', 'nodectl-traffic-up-bar');
  const downloadBar = node('span', 'nodectl-traffic-down-bar');
  fill.append(uploadBar, downloadBar); track.append(fill);
  const footer = node('div', 'nodectl-traffic-row-footer');
  const usage = node('div', 'nodectl-traffic-usage');
  const up = node('span', 'nodectl-traffic-up');
  const down = node('span', 'nodectl-traffic-down');
  const ratio = node('span', 'nodectl-traffic-ratio'); ratio.title = '下载 / 上传';
  const rates = node('div', 'nodectl-traffic-rates'); rates.setAttribute('aria-label', '当前实时速率');
  const upRate = node('span', 'nodectl-traffic-up');
  const downRate = node('span', 'nodectl-traffic-down');
  usage.append(up, down, ratio); rates.append(upRate, downRate); footer.append(usage, rates);
  root.append(heading, track, footer);
  return { root, flag, label, status, total, track, fill, uploadBar, downloadBar, up, down, ratio, upRate, downRate };
}

export function createTrafficPanel(onDateChange) {
  const root = node('section', 'nodectl-traffic-panel'); root.setAttribute('aria-label', '流量消耗');
  const header = node('header', 'nodectl-traffic-header');
  const title = node('h2', '', '流量消耗');
  const icon = node('span', 'nodectl-traffic-icon'); icon.setAttribute('aria-hidden', 'true');
  for (const height of [40, 65, 90]) { const bar = node('span'); bar.style.height = height + '%'; icon.append(bar); }
  title.prepend(icon);
  const filters = node('div', 'nodectl-traffic-filters');
  const lifetime = node('button', 'nodectl-traffic-lifetime', '累计'); lifetime.type = 'button'; lifetime.setAttribute('aria-pressed', 'true');
  const date = node('input', 'nodectl-traffic-date'); date.type = 'date'; date.setAttribute('aria-label', '流量统计日期');
  const now = new Date(); date.max = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  lifetime.addEventListener('click', () => { date.value = ''; onDateChange(null); });
  date.addEventListener('change', () => onDateChange(date.value || null));
  filters.append(lifetime, date); header.append(title, filters);
  const summary = node('div', 'nodectl-traffic-summary');
  const totals = {};
  for (const [key, label, className] of [['up', '上传', 'nodectl-traffic-up'], ['down', '下载', 'nodectl-traffic-down'], ['total', '总计', 'nodectl-traffic-ratio']]) {
    const metric = node('div'); const value = node('strong', className, '—'); value.dataset.trafficSummary = key;
    metric.append(node('span', 'nodectl-traffic-metric-label', label), value); summary.append(metric); totals[key] = value;
  }
  const list = node('div', 'nodectl-traffic-list');
  const empty = node('p', 'nodectl-traffic-empty', '正在读取服务器流量…');
  const status = node('p', 'nodectl-traffic-status');
  const hint = node('p', 'nodectl-traffic-hint', '累计按当前计费周期统计；选择日期可查看当日用量。速率来自 Agent 实时上报。');
  root.append(header, summary, list, empty, status, hint);
  const rows = new Map();
  return {
    root,
    update(snapshot, { date: selectedDate, loading = false, error = false, connected = false } = {}) {
      lifetime.setAttribute('aria-pressed', String(!selectedDate));
      root.setAttribute('aria-busy', String(loading));
      for (const key of ['up', 'down', 'total']) text(totals[key], loading ? '—' : formatTraffic(snapshot[key]));
      const identifiers = new Set(snapshot.rows.map(item => item.uuid));
      for (const [uuid, row] of rows) if (!identifiers.has(uuid)) { row.root.remove(); rows.delete(uuid); }
      snapshot.rows.forEach((item, index) => {
        let row = rows.get(item.uuid);
        if (!row) { row = trafficRow(); rows.set(item.uuid, row); row.root.dataset.uuid = item.uuid; }
        if (list.children[index] !== row.root) list.insertBefore(row.root, list.children[index] || null);
        row.root.classList.toggle('nodectl-traffic-leading', index === 0 && item.total > 0);
        text(row.flag, regionFlag(item.region)); row.flag.hidden = !regionFlag(item.region);
        text(row.label, item.name); text(row.total, formatTraffic(item.total));
        row.status.dataset.state = item.status;
        const statusLabel = { online: '在线', offline: '离线', pending: '等待上报', stale: '上报延迟' }[item.status];
        row.status.title = statusLabel; row.status.setAttribute('aria-label', statusLabel);
        row.track.setAttribute('aria-label', `${item.name} 上传 ${formatTraffic(item.up)}，下载 ${formatTraffic(item.down)}`);
        row.fill.style.width = `${item.total / snapshot.maximum * 100}%`;
        row.uploadBar.style.width = `${item.total ? item.up / item.total * 100 : 0}%`;
        row.downloadBar.style.width = `${item.total ? item.down / item.total * 100 : 0}%`;
        text(row.up, '↑ ' + formatTraffic(item.up)); text(row.down, '↓ ' + formatTraffic(item.down)); text(row.ratio, item.ratio);
        text(row.upRate, '↑ ' + formatTraffic(item.upRate, true)); text(row.downRate, '↓ ' + formatTraffic(item.downRate, true));
      });
      empty.hidden = snapshot.rows.length > 0;
      text(empty, loading ? '正在读取历史流量…' : error ? '流量读取失败，请刷新重试。' : selectedDate ? '该日期暂无流量记录。' : '暂无服务器。添加服务器后即可查看流量。');
      text(status, `${selectedDate ? selectedDate + ' 当日用量' : '当前累计用量'} · 0.5 秒刷新 · ${connected ? '实时连接已建立' : '实时连接重连中'}`);
    },
  };
}
