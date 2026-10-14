#!/usr/bin/env python3
"""Build the maintained routing branch in a fresh checkout; never install it."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
SOURCE = 'https://github.com/AdityaAmitK/search-routing.git'
BRANCH = 'routing'


def run(*command, cwd, env=None):
    subprocess.run(command, cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-only', action='store_true', help='clone and test without building or launching Search')
    args = parser.parse_args()
    state = ROOT / '.state'
    state.mkdir(exist_ok=True)
    checkout = Path(tempfile.mkdtemp(prefix='routing-source-', dir=state)).resolve()
    run('git', 'clone', '--depth', '1', '--single-branch', '--branch', BRANCH, SOURCE, str(checkout), cwd=ROOT)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
    version = (checkout / 'VERSION').read_text().strip()
    run(sys.executable, 'routing/tests/test_routing.py', '.', cwd=checkout)
    run(sys.executable, 'routing/tests/test_install.py', cwd=checkout)
    if args.check_only:
        print(f'Checked {SOURCE} branch {BRANCH} at {revision} ({version})\nSource: {checkout}')
        return
    arch = platform.machine()
    if arch not in ('arm64', 'x86_64'):
        raise SystemExit(f'Unsupported Mac architecture: {arch}')
    env = dict(os.environ, SEARCH_ARCH=arch)
    run('bash', 'build.sh', cwd=checkout, env=env)
    app = checkout / ('build/intel/Search.app' if arch == 'x86_64' else 'build/Search.app')
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(app), cwd=checkout)
    run(sys.executable, 'routing/tests/test_browser.py', '.', cwd=checkout,
        env=dict(env, SEARCH_TEST_APP=str(app)))
    provenance = dict(source=SOURCE, branch=BRANCH, revision=revision, version=version, architecture=arch)
    (app.parent / 'search-routing-build.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(f'Validated app: {app}\nInstallation is a separate explicit step: python3 install.py --install "{app}"')


if __name__ == '__main__':
    main()
