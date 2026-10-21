import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, exactKeys, UpdateError } from './release.mjs';

const activePhases = new Set(['preflight', 'download', 'backup', 'load', 'deploy', 'health', 'rolling-back']);
const changedPhases = new Set(['deploy', 'health', 'rolling-back']);
export function privateJson(destination, value) {
  const temporary = destination + '.tmp';
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  chmodSync(temporary, 0o600);
  const descriptor = openSync(temporary, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, destination);
  const directory = openSync(join(destination, '..'), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export async function createUpdateManager({ source, runner, stateDirectory }) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 }); chmodSync(stateDirectory, 0o700);
  const statePath = join(stateDirectory, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { schema: 1, current: await runner.current(), job: null };
  if (state.schema !== 1 || !state.current || typeof state.current.version !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(state.current.image) || (state.job && !/^[a-f0-9-]{36}$/.test(state.job.id))) throw new Error('Invalid private updater state');
  let busy = activePhases.has(state.job?.phase), checking = false, candidate = null, checkedAt = null, checkError = null, fatal = false;
  const persist = () => privateJson(statePath, state);
  const status = () => ({
    enabled: true, busy: busy || checking, blocked: fatal || state.job?.phase === 'manual-required',
    current: { version: state.current.version, revision: state.current.revision },
    latest: candidate ? { version: candidate.manifest.version, revision: candidate.manifest.revision, notes: candidate.notes, manifestSha256: candidate.manifestSha256 } : null,
    available: Boolean(candidate && compareVersions(candidate.manifest.version, state.current.version) > 0), checkedAt, checkError,
    job: state.job ? { id: state.job.id, phase: state.job.phase, version: state.job.version, startedAt: state.job.startedAt, finishedAt: state.job.finishedAt, error: state.job.error, warning: state.job.warning } : null,
  });
  const record = () => console.log(JSON.stringify({ event: 'gateway_update_phase', jobId: state.job.id, version: state.job.version, phase: state.job.phase }));
  const phase = value => { state.job.phase = value; persist(); record(); };
  const finish = value => { state.job.phase = value; state.job.finishedAt = new Date().toISOString(); persist(); record(); };
  async function restore() {
    phase('rolling-back');
    try {
      await runner.restore(state.job);
      state.current = state.job.previous;
      state.job.error = '更新未完成，已恢复旧版网关；原业务数据库未改动';
      finish('rolled-back');
    } catch { state.job.error = '自动回退未通过检查，需要管理员人工处理；已禁止继续更新'; finish('manual-required'); }
  }
  async function execute() {
    try {
      const release = candidate;
      state.job.baseline = await runner.preflight(release, state.job.previous); persist();
      phase('download'); await runner.download(state.job, release);
      phase('backup'); await runner.backup(state.job);
      phase('load'); await runner.load(state.job, release);
      phase('deploy'); await runner.deploy(release.manifest.selected.imageId);
      phase('health'); await runner.healthy({ version: release.manifest.version, revision: release.manifest.revision }, state.job.baseline);
      state.current = { version: release.manifest.version, revision: release.manifest.revision, image: release.manifest.selected.imageId };
      finish('succeeded');
    } catch {
      if (changedPhases.has(state.job.phase)) await restore();
      else { state.job.error = '部署前检查、下载或备份失败，未替换运行中的网关；请检查发布源、磁盘和更新器日志'; finish('failed'); }
    } finally {
      try { await runner.cleanup?.(state.job); }
      catch { state.job.warning = '备份清理未完成，请管理员检查磁盘空间'; persist(); }
      busy = false;
    }
  }
  persist();
  return {
    status,
    async recover() {
      if (!activePhases.has(state.job?.phase)) return;
      busy = true;
      try {
        if (changedPhases.has(state.job.phase)) await restore();
        else { state.job.error = '更新器曾中断，未进入网关替换阶段；请重新检查更新'; finish('failed'); }
      } finally { busy = false; }
    },
    async check() {
      if (busy || checking) throw new UpdateError(409, '更新任务正在进行，请稍后');
      checking = true;
      try { candidate = await source.latest(); checkedAt = new Date().toISOString(); checkError = null; }
      catch (error) { candidate = null; checkError = error instanceof UpdateError ? error.message : '无法检查已签名发布'; throw error; }
      finally { checking = false; }
      return status();
    },
    async apply(body) {
      if (fatal || state.job?.phase === 'manual-required') throw new UpdateError(409, '需要人工恢复后才能继续更新');
      if (busy || checking) throw new UpdateError(409, '更新任务正在进行，请勿重复提交');
      if (!exactKeys(body, ['version', 'manifestSha256'])) throw new UpdateError(400, '更新参数不符合要求');
      if (!candidate || !checkedAt || Date.now() - Date.parse(checkedAt) > 86400000) throw new UpdateError(409, '请先检查更新并确认目标版本');
      if (body.version !== candidate.manifest.version || body.manifestSha256 !== candidate.manifestSha256) throw new UpdateError(409, '更新确认已过期，请重新检查并确认');
      if (compareVersions(body.version, state.current.version) <= 0) throw new UpdateError(409, '没有比当前更高的更新版本');
      busy = true;
      state.job = { id: randomUUID(), phase: 'preflight', version: body.version, startedAt: new Date().toISOString(), previous: { ...state.current } };
      try { persist(); } catch (error) { busy = false; throw error; }
      const started = status();
      setImmediate(() => { execute().catch(() => { busy = false; fatal = true; state.job.phase = 'manual-required'; state.job.error = '更新状态无法安全写入，需要管理员检查磁盘并恢复；已禁止继续更新'; console.error('Updater state persistence failed; restart for recovery'); }); });
      return started;
    },
  };
}
