#!/usr/bin/env python3
"""Explicit, reversible installation; requires Search to be fully quit."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
TARGET = Path('/Applications/Search.app')
BACKUPS = ROOT / '.state/install-backups'
IDENTIFIER = 'com.officecommun.search'

def copy(source, target):
    subprocess.run(['/usr/bin/ditto', str(source), str(target)], check=True)

def copy_profile(source, target):
    # Unix sockets are runtime endpoints, not saved browser data.
    def sockets(directory, names):
        return [name for name in names
                if stat.S_ISSOCK((Path(directory) / name).lstat().st_mode)]
    shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True, ignore=sockets)

def verify(app):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != IDENTIFIER:
        raise SystemExit('Refusing bundle with unexpected identifier')
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)

def require_closed():
    status = subprocess.run(['/usr/bin/pgrep', '-x', 'Search'], stdout=subprocess.DEVNULL).returncode
    if status == 0:
        raise SystemExit('Quit Search completely before installing or rolling back.')
    if status != 1:
        raise SystemExit('Could not determine whether Search is running; installation stopped.')


def swap_bundle(fresh, target, old):
    """Rename on one volume, restoring the target if replacement fails."""
    existed = target.exists()
    if existed:
        target.rename(old)
    try:
        fresh.rename(target)
    except BaseException:
        if existed:
            old.rename(target)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument('--install', type=Path, metavar='BUILT_APP')
    choice.add_argument('--rollback', action='store_true', help='restore previous app bundle')
    args = parser.parse_args()
    require_closed()
    os.umask(0o077)
    BACKUPS.mkdir(parents=True, exist_ok=True)
    BACKUPS.chmod(0o700)
    previous = BACKUPS / 'previous.app'
    source = previous if args.rollback else args.install.resolve()
    if not source.is_dir() or not TARGET.is_dir():
        raise SystemExit('Source and existing installed app must both exist.')
    verify(source)
    # Preserve the original application and profile only once. Never print data.
    original = BACKUPS / 'original.app'
    complete = BACKUPS / "original-backup-complete"
    if not args.rollback and not complete.exists():
        if not original.exists():
            copy(TARGET, original)
        verify(original)
        support = Path.home() / 'Library/Application Support/Search'
        if support.exists():
            copy_profile(support, BACKUPS / 'original-support')
        result = subprocess.run(['/usr/bin/defaults', 'export', IDENTIFIER, str(BACKUPS / 'original-defaults.plist')], capture_output=True)
        if result.returncode:
            # No domain is valid for an unused browser; other errors are refused.
            check = subprocess.run(['/usr/bin/defaults', 'read', IDENTIFIER], capture_output=True)
            if check.returncode == 0:
                raise SystemExit('Could not back up existing browser settings.')
        complete.write_text("Original bundle, support folder and defaults backup completed.\n")
    # Stage on the destination volume; retain the old app until commit succeeds.
    staging = Path(tempfile.mkdtemp(prefix='.search-install-', dir=TARGET.parent))
    fresh, old = staging / 'Search.app', staging / 'old.app'
    backup_staging = Path(tempfile.mkdtemp(prefix='previous-', dir=BACKUPS))
    candidate, prior = backup_staging / 'candidate.app', backup_staging / 'prior.app'
    committed = False
    try:
        copy(source, fresh)
        verify(fresh)
        # ditto supports different filesystems; all following renames stay local.
        copy(TARGET, candidate)
        verify(candidate)
        swap_bundle(candidate, previous, prior)
        try:
            swap_bundle(fresh, TARGET, old)
        except BaseException:
            shutil.rmtree(previous)
            if prior.exists():
                prior.rename(previous)
            raise
        committed = True
        shutil.rmtree(old)
    finally:
        # Preserve a displaced app if restoration itself failed.
        if not old.exists():
            shutil.rmtree(staging)
        if committed or not prior.exists():
            shutil.rmtree(backup_staging)
    print('App bundle replaced. Browser data and settings were not modified.')

if __name__ == '__main__':
    main()
