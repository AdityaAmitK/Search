#!/usr/bin/env python3
"""Exercise Search's external-link handler in an isolated SEARCH_PROBE world."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import sys
import time
import uuid


def main(scenario='defaults'):
    checkout = Path(sys.argv[1]).resolve()
    world = 'bc-routing-' + uuid.uuid4().hex[:10]
    domain = 'com.officecommun.search.test.' + world
    folder = Path.home() / 'Library/Application Support' / f'Search ({world})'
    folder.mkdir()
    first = '00000000-0000-0000-0000-000000000001'
    spaces = [dict(id=first, name='Personal', colour=0)]
    spaces += [dict(id=str(uuid.uuid4()).upper(), name=name, colour=0, sharesSignIns=False)
               for name in ('Research', 'Work')]
    if scenario == 'custom':
        spaces[2]['name'] = 'Engineering'
    (folder / 'spaces.json').write_text(json.dumps(spaces))
    settings = folder / 'probe-settings.plist'
    preferences = {'bench': True, 'spaces': True, 'links.little': True, 'update.install': False}
    if scenario != 'defaults':
        def rule(domain, index, enabled=True):
            return dict(id=str(uuid.uuid4()), domain=domain, spaceID=spaces[index]['id'],
                        spaceName='Work' if index == 2 else spaces[index]['name'], enabled=enabled)
        rules = [rule('github.com', 2), rule('gist.github.com', 1), rule('x.com', 0, False)]
        preferences['external.routing'] = json.dumps(dict(enabled=True, rules=rules if scenario == 'custom' else [])).encode()
    cold_urls = ['http://x.com:9/cold-personal', 'http://github.com:9/cold-work']
    if scenario == 'custom':
        cold_urls = ['http://github.com:9/custom-base', 'http://gist.github.com:9/custom-specific']
    elif scenario == 'empty':
        cold_urls = []
    preferences['routing.probe.launchURLs'] = cold_urls
    settings.write_bytes(plistlib.dumps(preferences))
    subprocess.run(['defaults', 'import', domain, str(settings)], check=True)
    log_path = checkout / 'search-browser-probe.log'
    with log_path.open('w') as log:
        process = subprocess.Popen(['/usr/bin/open', '-n', '-W', '--env',
                                    f'SEARCH_PROBE={world}', '-a', os.environ.get('SEARCH_TEST_APP', str(checkout / 'build/Search.app'))],
                                   stdout=log, stderr=log)

    def ask(verb, **values):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(15)
            connection.connect(str(folder / 'bench.sock'))
            connection.sendall((json.dumps(dict(do=verb, **values)) + '\n').encode())
            chunks = []
            while chunk := connection.recv(65536):
                chunks.append(chunk)
        answer = json.loads(b''.join(chunks).split(b'\n')[0])
        assert 'error' not in answer, answer
        return answer

    def window():
        return ask('windows')['windows'][0]

    try:
        until = time.monotonic() + 30
        while not (folder / 'bench.sock').exists():
            assert process.poll() is None, f'Search exited; see {log_path}'
            if time.monotonic() > until:
                raise TimeoutError(f'Search did not start; see {log_path}')
            time.sleep(.1)
        # The bench starts before SwiftUI finishes assembling the menu/window.
        # Its windows probe replies after a run-loop turn and lets that finish.
        window()
        ask('window')
        if scenario == 'custom':
            for index, url, name in [(3, cold_urls[0], 'Engineering'),
                                     (2, cold_urls[1], 'Research')]:
                ask('space', action='go', index=index)
                result = window()
                assert result['space'] == name and url in result['tabs'], result
            before = window()['tabs']
            ask('windows', action='link', url='http://x.com:9/disabled-rule')
            assert window()['space'] == 'Research' and window()['tabs'] == before
            print('Browser saved config: specific override, renamed destination, disabled rule passed')
            return
        if scenario == 'empty':
            ask('space', action='go', index=2)
            before = window()['tabs']
            ask('windows', action='link', url='http://github.com:9/empty-rules')
            assert window()['space'] == 'Research' and window()['tabs'] == before
            print('Browser saved empty config: defaults were not restored')
            return
        # External URLs that launch the application must land in their own
        # spaces too, including mixed batches delivered before the first window.
        for index, own, other in [(1, cold_urls[0], cold_urls[1]),
                                  (3, cold_urls[1], cold_urls[0])]:
            ask('space', action='go', index=index)
            tabs = window()['tabs']
            assert own in tabs and other not in tabs, (index, tabs)
        # Closed port: exercise routing without loading real account pages.
        for host, target in [('x.com', 'Personal'), ('mobile.twitter.com', 'Personal'),
                             ('youtube.com', 'Personal'), ('youtu.be', 'Personal'),
                             ('team.slack.com', 'Work'), ('team.sentry.io', 'Work'),
                             ('linear.app', 'Work'), ('github.com', 'Work'),
                             ('github.com.', 'Work')]:
            ask('space', action='go', index=2)
            url = f'http://{host}:9/routing-test'
            result = ask('windows', action='link', url=url)['windows'][0]
            assert result['space'] == target, (host, result)
            assert url in result['tabs'], (host, result)
        # Spoofed/unmapped domains retain the current space. Little-window
        # preference is enabled, so also verify mapped pages bypass it above.
        ask('space', action='go', index=2)
        ask('windows', action='link', url='http://github.com.evil.invalid:9/')
        assert window()['space'] == 'Research'
        # The internal tab-opening API must not use external routing.
        ask('open', url='http://github.com:9/internal-test')
        assert window()['space'] == 'Research'
        # Disabled Spaces refuses mapped URLs rather than using wrong cookies.
        ask('ui', spaces=False)
        before = window()['tabs']
        ask('windows', action='link', url='http://github.com:9/blocked-disabled')
        assert window()['tabs'] == before
        ask('ui', spaces=True)
        # A missing named destination also refuses the URL.
        ask('space', action='go', index=3)
        ask('space', action='delete')
        before = window()['tabs']
        ask('windows', action='link', url='http://github.com:9/blocked-missing')
        assert window()['tabs'] == before
        print('Browser integration: cold launch, 9 routes, spoofed host, internal open, disabled/missing spaces passed')
    finally:
        if process.poll() is None:
            try:
                ask('quit')
                process.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                process.terminate()
                process.wait(timeout=10)
        subprocess.run(['defaults', 'delete', domain], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(folder)


if __name__ == '__main__':
    main()
    main('custom')
    main('empty')
