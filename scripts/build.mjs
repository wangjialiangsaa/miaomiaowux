import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const common = readFileSync(new URL('scripts/common.sh', root), 'utf8').trimEnd();
let stale = false;
for (const name of ['install.sh', 'upgrade-agent.sh']) {
  const template = readFileSync(new URL(`scripts/${name}.in`, root), 'utf8');
  const result = template.replace('# @COMMON@', () => common);
  const target = new URL(name, root);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== result) { console.error(`Regenerate ${name}`); stale = true; }
  } else { writeFileSync(target, result, { mode: 0o755 }); console.log(fileURLToPath(target)); }
}
if (stale) process.exitCode = 1;
