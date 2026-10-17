"""Failure injection against the real entry points; all writes stay in a temp directory."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
STUB = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, time
args = sys.argv[1:]
tool = pathlib.Path(sys.argv[0]).name
root = pathlib.Path(os.environ['MOCK_ROOT'])
state = root / 'running'
binary = pathlib.Path(os.environ['MOCK_BINARY'])
new = binary.exists() and binary.read_bytes().endswith(b'NEW')
def log(action):
    with (root / 'actions').open('a') as f: f.write(action + '\n')
if tool == 'curl':
    if '--config' in args: sys.stdin.read()
    if '-o' in args and args[args.index('-o') + 1] != '/dev/null':
        out = pathlib.Path(args[args.index('-o') + 1])
        if any('api.github.com' in arg for arg in args):
            if os.environ.get('MOCK_EMPTY_RELEASES'): out.write_text('[]')
            else: out.write_text((root / 'release.json').read_text())
        else:
            out.write_bytes(b'broken' if os.environ.get('MOCK_DOWNLOAD_BAD') else (root / 'candidate').read_bytes())
    sys.exit(1 if os.environ.get('MOCK_HEALTH_FAIL') and new else 0)
if tool == 'cp':
    if os.environ.get('MOCK_BACKUP_FAIL') and args[-1].endswith('/old-bin'): sys.exit(1)
    os.execv('/bin/cp', ['/bin/cp'] + args)
if tool == 'install':
    if args[-1].endswith('/ready-bin'):
        if os.environ.get('MOCK_REPLACE_FAIL'): sys.exit(1)
        if os.environ.get('MOCK_PAUSE'):
            (root / 'paused').touch()
            time.sleep(20)
    os.execv('/usr/bin/install', ['/usr/bin/install'] + args)
if tool == 'systemctl':
    command = args[0]
    if command == 'show-environment': sys.exit(1 if os.environ.get('MOCK_OPENRC') else 0)
    if command == 'show':
        if os.environ.get('MOCK_QUERY_FAIL'): sys.exit(1)
        if '--property=LoadState' in args:
            print('loaded' if (pathlib.Path(os.environ['MMWX_UNIT_DIR']) / 'mmwx-check.service').exists() or os.environ.get('MOCK_VENDOR_UNIT') else 'not-found')
        elif '--property=ActiveState' in args:
            print('active' if state.read_text() == '1' else 'inactive')
        else: print('PORT=12889')
        sys.exit(0)
elif tool == 'rc-service':
    if args[0] == '--exists': sys.exit(0)
    command = args[1]
else: sys.exit('Unknown stub')
if command in ('is-active', 'status'):
    sys.exit(0 if state.read_text() == '1' else 3)
if command in ('start', 'stop', 'enable', 'disable', 'daemon-reload'):
    log(command)
    if command == 'stop':
        if os.environ.get('MOCK_STOP_FAIL'): sys.exit(1)
        state.write_text('0')
    elif command == 'start':
        if new and os.environ.get('MOCK_START_FAIL'): sys.exit(1)
        state.write_text('1')
    elif command == 'enable' and os.environ.get('MOCK_ENABLE_FAIL'): sys.exit(1)
    sys.exit(0)
sys.exit('Unexpected service command: ' + repr(args))
'''


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'Linux root test runner required')
class Installers(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mmwx-check-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.prefix = self.root / 'instance'
        self.units = self.root / 'units'
        self.stubs = self.root / 'stubs'
        self.units.mkdir(); self.stubs.mkdir()
        for tool in ['systemctl', 'rc-service', 'curl', 'install', 'cp']:
            path = self.stubs / tool
            path.write_text(STUB); path.chmod(0o755)
        self.new = Path('/bin/true').read_bytes() + b'NEW'
        self.old = Path('/bin/true').read_bytes() + b'OLD'
        self.candidate = self.root / 'candidate'
        self.candidate.write_bytes(self.new)
        (self.root / 'running').write_text('1')
        self.env = dict(os.environ, MOCK_ROOT=str(self.root), MMWX_UNIT_DIR=str(self.units),
                        PATH=str(self.stubs) + os.pathsep + os.environ['PATH'])

    def command(self, agent=False, fresh=False, online=False, extra=()):
        binary = self.prefix / 'bin' / ('mmw-agent' if agent else 'mmwx')
        binary.parent.mkdir(parents=True, exist_ok=True)
        self.env['MOCK_BINARY'] = str(binary)
        unit = self.units / 'mmwx-check.service'
        if not fresh and not binary.exists():
            binary.write_bytes(self.old); binary.chmod(0o755)
            unit.write_text('preserved custom service\n')
        if fresh: (self.root / 'running').write_text('0')
        data = self.prefix / 'data'
        data.mkdir(exist_ok=True)
        (data / 'config-preserved').write_text('existing-data')
        command = ['bash', str(ROOT / ('upgrade-agent.sh' if agent else 'install.sh'))]
        if not agent: command += ['install' if fresh else 'update']
        command += ['--prefix', str(self.prefix), '--service', 'mmwx-check', '--health-timeout', '3']
        if online:
            tag = 'mmwx-agent-v1.0' if agent else 'mmwx-v1.0'
            name = ('mmwx-agent' if agent else 'mmwx') + '-linux-' + ('arm64' if os.uname().machine == 'aarch64' else 'amd64')
            (self.root / 'release.json').write_text(json.dumps([{'tag_name': tag, 'assets': [{
                'name': name, 'digest': 'sha256:' + hashlib.sha256(self.new).hexdigest(),
                'browser_download_url': f'https://github.com/zako-li/miaomiaowux/releases/download/{tag}/{name}'
            }]}]))
        else: command += ['--binary', str(self.candidate), '--sha256', hashlib.sha256(self.candidate.read_bytes()).hexdigest()]
        return command + list(extra), binary, unit

    def run_case(self, *, agent=False, fresh=False, online=False, fail=None, running=True, extra=()):
        command, binary, unit = self.command(agent, fresh, online, extra)
        if not fresh: (self.root / 'running').write_text('1' if running else '0')
        if fail: self.env['MOCK_' + fail] = '1'
        result = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=20)
        actions = (self.root / 'actions').read_text().splitlines() if (self.root / 'actions').exists() else []
        self.assertEqual((self.prefix / 'data/config-preserved').read_text(), 'existing-data')
        return result, binary, unit, actions

    def test_success_and_previous_backup(self):
        for agent in [False, True]:
            with self.subTest(agent=agent):
                result, binary, unit, actions = self.run_case(agent=agent)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(binary.read_bytes(), self.new)
                self.assertEqual(Path(str(binary) + '.previous').read_bytes(), self.old)
                self.assertEqual(unit.read_text(), 'preserved custom service\n')

    def test_start_failure_rolls_back(self):
        for agent in [False, True]:
            with self.subTest(agent=agent):
                result, binary, _, _ = self.run_case(agent=agent, fail='START_FAIL')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(binary.read_bytes(), self.old)
                self.assertEqual((self.root / 'running').read_text(), '1')

    def test_http_health_failure_rolls_back(self):
        result, binary, _, _ = self.run_case(fail='HEALTH_FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), self.old)

    def test_stopped_service_stays_stopped(self):
        for agent in [False, True]:
            result, binary, _, actions = self.run_case(agent=agent, running=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(binary.read_bytes(), self.new)
            self.assertNotIn('start', actions)
            self.assertEqual((self.root / 'running').read_text(), '0')

    def test_stop_failure_never_replaces_binary(self):
        result, binary, _, _ = self.run_case(fail='STOP_FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), self.old)

    def test_backup_failure_does_not_stop_service(self):
        result, binary, _, actions = self.run_case(fail='BACKUP_FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('stop', actions)
        self.assertEqual(binary.read_bytes(), self.old)

    def test_replace_failure_recovers_service(self):
        result, binary, _, _ = self.run_case(fail='REPLACE_FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), self.old)
        self.assertEqual((self.root / 'running').read_text(), '1')

    def test_first_install_success(self):
        result, binary, unit, actions = self.run_case(fresh=True, extra=['--port', '12990'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PORT=12990', unit.read_text())
        self.assertIn(f'WorkingDirectory="{self.prefix}/data"', unit.read_text())
        self.assertIn('enable', actions)

    def test_failed_first_install_removes_program_and_unit(self):
        result, binary, unit, _ = self.run_case(fresh=True, fail='START_FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(binary.exists()); self.assertFalse(unit.exists())

    def test_enable_failure_also_rolls_back(self):
        result, binary, unit, _ = self.run_case(fresh=True, fail='ENABLE_FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(binary.exists()); self.assertFalse(unit.exists())

    def test_checksum_failure_does_not_stop_service(self):
        result, binary, _, actions = self.run_case(extra=['--sha256', '0' * 64])
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('stop', actions)
        self.assertEqual(binary.read_bytes(), self.old)

    def test_html_instead_of_elf_is_rejected_before_stop(self):
        self.candidate.write_bytes(b'<html>not a program</html>')
        result, binary, _, actions = self.run_case()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('stop', actions)

    def test_online_asset_digest_and_corrupt_download(self):
        result, binary, _, _ = self.run_case(online=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Restore the original program before injecting a bad download.
        binary.write_bytes(self.old)
        result, binary, _, actions = self.run_case(online=True, fail='DOWNLOAD_BAD')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), self.old)

    def test_openrc_agent_failure_rolls_back(self):
        self.env['MOCK_OPENRC'] = '1'
        self.env['MMWX_INIT'] = 'openrc'
        result, binary, _, _ = self.run_case(agent=True, fail='START_FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), self.old)
        self.assertEqual((self.root / 'running').read_text(), '1')

    def test_parameter_validation_and_stdin_help(self):
        for args in [['--port'], ['--port', '65536'], ['--health-timeout', '0'], ['--service', 'bad/name'],
                     ['--data-dir', '/tmp/path\nInjected=yes'], ['--health-url', 'http://example.com/']]:
            result, _, _, actions = self.run_case(extra=args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertNotIn('stop', actions)
        result = subprocess.run(['bash', '-s', '--', '--help'], input=(ROOT / 'install.sh').read_text(), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('用法', result.stdout)

    def test_state_query_error_does_not_replace_program(self):
        result, binary, _, actions = self.run_case(fail='QUERY_FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), self.old)
        self.assertNotIn('stop', actions)

    def test_vendor_unit_is_not_overwritten(self):
        command, binary, unit = self.command()
        unit.unlink(); self.env['MOCK_VENDOR_UNIT'] = '1'
        result = subprocess.run(command, env=self.env, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), self.old)
        self.assertFalse(unit.exists())

    def test_lock_symlink_and_backup_directory_are_rejected(self):
        command, binary, _ = self.command()
        victim = self.root / 'keep'; victim.write_text('keep')
        lock = Path(str(binary) + '.update.lock')
        lock.symlink_to(victim)
        result = subprocess.run(command, env=self.env, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(victim.read_text(), 'keep')
        lock.unlink(); Path(str(binary) + '.previous').mkdir()
        result = subprocess.run(command, env=self.env, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), self.old)

    def test_termination_recovers_and_lock_rejects_concurrency(self):
        command, binary, _ = self.command()
        self.env['MOCK_PAUSE'] = '1'
        process = subprocess.Popen(command, env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            deadline = time.monotonic() + 10
            while not (self.root / 'paused').exists():
                self.assertIsNone(process.poll())
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.05)
            result = subprocess.run(command, env=self.env, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            os.killpg(process.pid, signal.SIGTERM)
            self.assertNotEqual(process.wait(timeout=10), 0)
            self.assertEqual(binary.read_bytes(), self.old)
            self.assertEqual((self.root / 'running').read_text(), '1')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL); process.wait()


if __name__ == '__main__':
    unittest.main()
