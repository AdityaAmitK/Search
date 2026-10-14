#!/usr/bin/env python3
"""Compile actual Swift config/policy and validate URL and editor boundaries."""
from pathlib import Path
import subprocess
import sys
import tempfile

checkout = Path(sys.argv[1])
text = (checkout / 'Sources/Search/Routing.swift').read_text()
policy = text[text.index('enum InternalRoutingPolicy:'):text.index('@MainActor')]
harness = r'''
let personal = UUID(), work = UUID()
let base = RoutingRule(domain: "github.com", spaceID: work, spaceName: "Work")
let child = RoutingRule(domain: "gist.github.com", spaceID: personal, spaceName: "Personal")
var config = RoutingConfig(rules: [base, child])
func match(_ text: String) -> UUID? { config.match(URL(string: text)!)?.spaceID }
assert(match("https://GITHUB.COM./path") == work)
assert(match("https://gist.github.com/a") == personal)
assert(match("https://a.gist.github.com") == personal)
for text in ["https://notgithub.com", "https://github.com.evil.test", "https://github.com@evil.test", "https://example.com/?next=https://github.com", "file:///tmp/github.com", "ftp://github.com"] {
    assert(match(text) == nil, text)
}
config.rules[1].enabled = false
assert(match("https://gist.github.com") == work)
config.enabled = false
assert(match("https://github.com") == nil)
config = RoutingConfig(rules: [])
assert(match("https://github.com") == nil)
assert(RoutingConfig.domain("  GITHUB.COM. \n") == "github.com")
assert(RoutingConfig.domain("a-b.example.com") == "a-b.example.com")
for input in ["", "localhost:3000", "https://github.com", "github.com/path", "me@github.com", "github.com:443", "*.github.com", ".github.com", "github..com", "-github.com", "github-.com", "github.com..", "192.168.1.1", "::2", "github_com", "💻.com", String(repeating: "a", count: 64) + ".com"] {
    assert(RoutingConfig.domain(input) == nil, input)
}
for host in ["localhost", "127.0.0.1", "::1"] {
    let local = RoutingRule(domain: host, port: 3000, spaceID: work, spaceName: "Work")
    let fallback = RoutingRule(domain: host, spaceID: personal, spaceName: "Personal")
    config = RoutingConfig(rules: [local, fallback])
    let urlHost = host.contains(":") ? "[" + host + "]" : host
    assert(match("http://\(urlHost):3000") == work)
    assert(match("http://\(urlHost):3001") == personal)
    config.rules = [local]
    assert(match("http://\(urlHost):3001") == nil)
    assert(match("http://spoof.localhost:3000") == nil)
}
for input in ["0", "65536", "+80", " 80", "８０"] { assert(RoutingConfig.port(input) == nil) }
assert(RoutingConfig.domain("[::1]") == "::1")
for (scheme, port) in [("http", 80), ("https", 443)] {
    config = RoutingConfig(rules: [RoutingRule(domain: "github.com", port: port, spaceID: work, spaceName: "Work")])
    assert(match("\(scheme)://github.com") == work)
    assert(match("\(scheme)://github.com:\(port)") == work)
}
config = RoutingConfig(rules: [])
let encoded = try JSONEncoder().encode(RoutingConfig(rules: [base]))
let decoded = try JSONDecoder().decode(RoutingConfig.self, from: encoded)
assert(decoded.rules[0].spaceID == work)
assert(decoded.rules[0].id == base.id)
let empty = try JSONDecoder().decode(RoutingConfig.self, from: JSONEncoder().encode(config))
assert(empty.rules.isEmpty)
let legacy = try JSONSerialization.data(withJSONObject: ["enabled": true, "rules": [["id": base.id.uuidString, "domain": base.domain, "spaceID": work.uuidString, "spaceName": "Work", "enabled": true]]])
let old = try JSONDecoder().decode(RoutingConfig.self, from: legacy)
assert(old.internalPolicy == .current && old.rules[0].internalPolicy == .inherit && old.rules[0].port == nil)
assert(old.policy(for: old.rules[0]) == .current)
var overrides = RoutingConfig(rules: [base], internalPolicy: .ask)
assert(overrides.policy(for: base) == .ask)
for policy in [InternalRoutingOverride.current, .ask, .destination] {
    overrides.rules[0].internalPolicy = policy
    assert(overrides.policy(for: overrides.rules[0]).rawValue == policy.rawValue)
    let roundTrip = try JSONDecoder().decode(RoutingConfig.self, from: JSONEncoder().encode(overrides))
    assert(roundTrip == overrides)
}
print("Swift routing policy: matching, specificity, validation, toggles, identity and saved-empty checks passed")
'''
links = (checkout / 'Sources/Search/Links.swift').read_text()
assert 'guard prepareExternal(url, in: browser) else { return }' in links
assert 'if let browser, prepareExternal(first, in: browser) { browser.arrive(first) }' in links
assert 'guard let browser, prepareExternal(url, in: browser) else { return }' in links
with tempfile.TemporaryDirectory() as folder:
    path = Path(folder) / 'policy.swift'
    path.write_text('import Foundation\n' + policy + harness)
    subprocess.run(['swift', str(path)], check=True)
