#!/usr/bin/env python3
"""No real application or profile paths are touched by these checks."""
import importlib.util
from pathlib import Path
import tempfile
import socket
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[2] / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
    def test_profile_backup_preserves_files_and_skips_runtime_socket(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / 'profile', root / 'backup'
            source.mkdir()
            (source / 'session.json').write_text('{"saved":true}')
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(source / 'bench.sock'))
                installer.copy_profile(source, target)
            self.assertEqual((target / 'session.json').read_text(), '{"saved":true}')
            self.assertFalse((target / 'bench.sock').exists())

    def test_failed_swap_restores_existing_app(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target, old, fresh = root / 'installed.app', root / 'old.app', root / 'missing.app'
            target.mkdir()
            (target / 'identity').write_text('original')
            with self.assertRaises(FileNotFoundError):
                installer.swap_bundle(fresh, target, old)
            self.assertEqual((target / 'identity').read_text(), 'original')
            self.assertFalse(old.exists())

    def test_running_app_blocks_before_mutations(self):
        with patch.object(installer.subprocess, 'run') as run:
            run.return_value.returncode = 0
            with self.assertRaisesRegex(SystemExit, 'Quit Search'):
                installer.require_closed()
            self.assertEqual(run.call_args.args[0], ['/usr/bin/pgrep', '-x', 'Search'])

if __name__ == '__main__':
    unittest.main()
