# Search Browser

A fork of [Search by Office Commun](https://github.com/driceroland/Search), currently based on **v1.0.5**, with configurable URL routing between Spaces. The application still appears as **Search** on macOS.

Routing lives directly in this fork's Swift source on the `main` branch. There is no separate patch to apply. The related upstream [feature request #595](https://github.com/driceroland/Search/issues/595) and [PR #596](https://github.com/driceroland/Search/pull/596) remain references for the original proposal.

## Routing

Enable Spaces, then configure routing in Settings. Rules match a host and its subdomains; a more specific host wins. For example, route `github.com` to Work and `gist.github.com` to Research. Host matching ignores case and a trailing dot, and never matches an unrelated host containing the same text. Destination Spaces are stored by identity, so renaming a Space preserves its rules.

A blank port matches **all ports**. Set a port to narrow a rule, including a local development address such as `localhost` on port `3000`. `localhost`, `127.0.0.1`, and `::1` are supported as exact local hosts; enter the port separately. Explicit port rules also match the scheme's default port when omitted from a URL.

External links use the matched destination Space. For links followed inside Search, choose a global policy: stay in the current Space, ask where to open, or open in the destination Space. Each rule can inherit that policy or override it. Ask lets you choose the current Space or any available Space before opening. This applies to user navigation; embedded resources and background requests do not switch Spaces.

Initial rules send social/video hosts to Personal and development/work hosts to Work when those Spaces exist. Rules can be edited, disabled, or deleted, and an empty list stays empty. Unmatched links retain Search's normal behavior.

## Build and validate

Requires macOS 14 or later, Python 3, Git, and the Xcode tools needed by upstream Search. Clone this fork's maintained branch:

```sh
git clone --branch main https://github.com/AdityaAmitK/Search-Browser.git
cd Search-Browser
python3 routing/tests/test_routing.py .
python3 routing/tests/test_install.py
bash build.sh
python3 routing/tests/test_browser.py .
```

The browser test launches an isolated probe profile and removes it afterward. It does not use your normal browser profile. On Intel, the build is at `build/intel/Search.app`; pass `SEARCH_TEST_APP="$PWD/build/intel/Search.app"` to the browser test.

Upstream's build script produces `build/Search.app` on Apple Silicon and `build/intel/Search.app` on Intel. Without a Developer ID certificate it signs locally with an ad-hoc signature. This is not an Office Commun release or a notarized distribution. The bundle keeps Search's identifier and uses the same existing profile; changes in signing identity can cause macOS keychain permission prompts. Passkeys require the appropriate Apple entitlement and provisioning profile, as described in the [upstream documentation](routing/UPSTREAM_README.md).

## Install or roll back

Quit Search completely first. For an existing `/Applications/Search.app` installation:

```sh
python3 install.py --install "$PWD/build/Search.app"
# Restore the immediately previous installed bundle:
python3 install.py --rollback
```

Use the Intel path above when applicable. The installer verifies the signature and identifier, backs up the original app, support folder, and settings once under `.state/install-backups`, and retains the previous app for rollback. Installation and rollback replace the app bundle while preserving the active browser profile; rollback does not rewind browser data. Keep `.state` private and retain it for recovery. If Search is not installed yet, copy the validated app to `/Applications/Search.app` manually.

## Updates

Run `python3 update.py --check-only` to fetch a fresh checkout of this fork's `main` branch and run routing policy and installer checks. Run `python3 update.py` to additionally build it, verify its signature, and run browser integration checks. Successful builds include `search-browser-build.json` beside the app, recording the source, branch, revision, version, and architecture. Checkouts remain in `.state` for review.

The helper does not install the app. Review the result, quit Search, and run the explicit installation command it prints. Fork updates come from the maintained `main` branch. Upstream releases are incorporated by manually merging the upstream release, reviewing conflicts, and rerunning the checks before publishing the branch. Search still checks for upstream update notifications, but this fork blocks in-app replacement and directs you to rebuild here so routing is retained.

## Credits and license

Search is created by Office Commun and distributed under the [MIT license](LICENSE). This fork preserves that license and upstream attribution. See the [preserved upstream README](routing/UPSTREAM_README.md) for Search's browser features, shortcuts, privacy design, and development documentation. Its download links and stock updater instructions describe the upstream product.
