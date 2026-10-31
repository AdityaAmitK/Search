import SwiftUI

enum InternalRoutingPolicy: String, Codable, CaseIterable {
    case current, ask, destination
    var label: String {
        switch self {
        case .current: "Current Space"
        case .ask: "Ask where to open"
        case .destination: "Route to rule destination"
        }
    }
}

enum InternalRoutingOverride: String, Codable, CaseIterable {
    case inherit, current, ask, destination
    var label: String {
        self == .inherit ? "Inherit global" : InternalRoutingPolicy(rawValue: rawValue)?.label ?? "Inherit global"
    }
}

struct RoutingRule: Codable, Identifiable, Equatable {
    var id = UUID()
    var domain: String
    var port: Int?
    /// Legacy source profile, retained only to recover the original destination.
    var profileID: UUID?
    var destinationProfileID: UUID?
    var destinationProfile: UUID { destinationProfileID ?? profileID ?? Profile.personalID }
    var spaceID: UUID
    var spaceName: String
    var enabled = true
    var internalPolicy: InternalRoutingOverride = .inherit

    enum CodingKeys: String, CodingKey { case id, domain, port, profileID, destinationProfileID, spaceID, spaceName, enabled, internalPolicy }
    init(id: UUID = UUID(), domain: String, port: Int? = nil, spaceID: UUID, spaceName: String,
         enabled: Bool = true, internalPolicy: InternalRoutingOverride = .inherit, profileID: UUID? = nil, destinationProfileID: UUID? = nil) {
        self.id = id; self.domain = domain; self.port = port; self.spaceID = spaceID; self.spaceName = spaceName
        self.enabled = enabled; self.internalPolicy = internalPolicy
        self.profileID = profileID
        self.destinationProfileID = destinationProfileID
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        domain = try values.decode(String.self, forKey: .domain)
        port = try values.decodeIfPresent(Int.self, forKey: .port)
        profileID = try values.decodeIfPresent(UUID.self, forKey: .profileID)
        destinationProfileID = try values.decodeIfPresent(UUID.self, forKey: .destinationProfileID)
        spaceID = try values.decode(UUID.self, forKey: .spaceID)
        spaceName = try values.decode(String.self, forKey: .spaceName)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        internalPolicy = try values.decodeIfPresent(InternalRoutingOverride.self, forKey: .internalPolicy) ?? .inherit
    }
    var hostLabel: String {
        guard let port else { return domain }
        return "\(domain.contains(":") ? "[" + domain + "]" : domain):\(port)"
    }
}

struct RoutingConfig: Codable, Equatable {
    var enabled = true
    var rules: [RoutingRule] = []
    var internalPolicy: InternalRoutingPolicy = .current

    enum CodingKeys: String, CodingKey { case enabled, rules, internalPolicy }
    init(enabled: Bool = true, rules: [RoutingRule] = [], internalPolicy: InternalRoutingPolicy = .current) {
        self.enabled = enabled; self.rules = rules; self.internalPolicy = internalPolicy
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        rules = try values.decodeIfPresent([RoutingRule].self, forKey: .rules) ?? []
        // Preserve account destinations when migrating profile-local rules.
        for index in rules.indices {
            rules[index].destinationProfileID = rules[index].destinationProfile
            rules[index].profileID = nil
        }
        internalPolicy = try values.decodeIfPresent(InternalRoutingPolicy.self, forKey: .internalPolicy) ?? .current
        // Keep every conflicting rule for the user to resolve; never pick an account.
        if hasDuplicateRules { enabled = false }
    }
    var hasDuplicateRules: Bool {
        Dictionary(grouping: rules, by: \.hostLabel).values.contains { $0.count > 1 }
    }
    func policy(for rule: RoutingRule) -> InternalRoutingPolicy {
        InternalRoutingPolicy(rawValue: rule.internalPolicy.rawValue) ?? internalPolicy
    }

    static func domain(_ input: String) -> String? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.hasSuffix(".") { text.removeLast() }
        if text == "[::1]" { text = "::1" }
        if isLocalHost(text) { return text }
        guard text.count <= 253, text.contains("."), text.allSatisfy({
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == ".")
        }) else { return nil }
        let labels = text.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ label in
            !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
        }), labels.last?.contains(where: { $0.isLetter }) == true else { return nil }
        return text
    }

    static func isLocalHost(_ host: String) -> Bool { ["localhost", "127.0.0.1", "::1"].contains(host) }

    static func port(_ text: String) -> Int? {
        guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Int(text), (1...65535).contains(value) else { return nil }
        return value
    }

    // The legacy profile argument is ignored: the rule list applies everywhere.
    func match(_ url: URL, profileID _: UUID = Profile.personalID) -> RoutingRule? {
        guard enabled, !hasDuplicateRules, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host.flatMap(Self.domain) else { return nil }
        let port = url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
        return rules.filter { rule in
            rule.enabled && Self.domain(rule.domain) == rule.domain &&
                (rule.port.map { (1...65535).contains($0) } ?? true) &&
                (rule.port == nil || rule.port == port) &&
                (host == rule.domain || (!Self.isLocalHost(rule.domain) && host.hasSuffix("." + rule.domain)))
        }.max {
            if $0.domain.count != $1.domain.count { return $0.domain.count < $1.domain.count }
            return $0.port == nil && $1.port != nil
        }
    }
}

@MainActor
final class Routing: ObservableObject {
    static let shared = Routing()
    static let key = "external.routing"
    @Published private(set) var config: RoutingConfig

    private init() {
        if Store.settings.object(forKey: Self.key) != nil {
            // A saved empty list stays empty. Corrupt settings never reseed rules.
            config = Store.settings.data(forKey: Self.key)
                .flatMap { try? JSONDecoder().decode(RoutingConfig.self, from: $0) }
                ?? RoutingConfig(enabled: false)
        } else {
            let spaces = Spaces.read()
            let defaults = [("Personal", ["x.com", "twitter.com", "t.co", "youtube.com", "youtu.be"]),
                            ("Work", ["sentry.io", "slack.com", "linear.app", "github.com"])]
            config = RoutingConfig(rules: defaults.flatMap { name, domains in
                let space = spaces.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
                let id = space?.id ?? UUID()
                return domains.map { RoutingRule(domain: $0, spaceID: id, spaceName: name, destinationProfileID: space?.profileID) }
            })
        }
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(config) { Store.settings.set(data, forKey: Self.key) }
    }

    func setInternalPolicy(_ policy: InternalRoutingPolicy) { config.internalPolicy = policy; persist() }
    func setEnabled(_ enabled: Bool) {
        guard !enabled || !config.hasDuplicateRules else { return }
        config.enabled = enabled
        persist()
    }
    func setRuleEnabled(_ id: UUID, _ enabled: Bool) {
        guard let index = config.rules.firstIndex(where: { $0.id == id }) else { return }
        config.rules[index].enabled = enabled
        persist()
    }
    func remove(_ id: UUID) { config.rules.removeAll { $0.id == id }; persist() }
    @discardableResult
    func save(id: UUID?, domain input: String, port: Int? = nil, space: Space, internalPolicy: InternalRoutingOverride = .inherit) -> Bool {
        guard Profiles.shared.list.contains(where: { $0.id == space.profileID }),
              Spaces.read(profile: space.profileID).contains(where: { $0.id == space.id }),
              let domain = RoutingConfig.domain(input), port.map({ (1...65535).contains($0) }) ?? true,
              !config.rules.contains(where: { $0.domain == domain && $0.port == port && $0.id != id }) else { return false }
        if let id, let index = config.rules.firstIndex(where: { $0.id == id }) {
            config.rules[index].domain = domain
            config.rules[index].port = port
            config.rules[index].profileID = nil
            config.rules[index].destinationProfileID = space.profileID
            config.rules[index].spaceID = space.id
            config.rules[index].spaceName = space.name
            config.rules[index].internalPolicy = internalPolicy
        } else {
            config.rules.append(RoutingRule(domain: domain, port: port, spaceID: space.id, spaceName: space.name, internalPolicy: internalPolicy, destinationProfileID: space.profileID))
        }
        persist()
        return true
    }

    static func browser(for spaceID: UUID, profileID: UUID, from source: Browser,
                        foreground: Bool) -> Browser? {
        guard let profile = Profiles.shared.list.first(where: { $0.id == profileID }),
              Spaces.read(profile: profileID).contains(where: { $0.id == spaceID }) else {
            source.announce("Link not opened: choose an existing profile and Space in Settings → Routing")
            return nil
        }
        guard source.prefs.usesSpaces || spaceID == profile.home else {
            source.announce("Link not opened: enable Spaces in Settings → Spaces & Pins")
            return nil
        }
        let target = profileID == source.profileID ? source : Browsers.open(profile: profileID, foreground: foreground)
        if target.spaceID != spaceID { target.switchSpace(to: spaceID) }
        guard target.profileID == profileID, target.spaceID == spaceID else {
            source.announce("Link not opened: the destination is no longer available")
            return nil
        }
        if foreground, let window = target.window, window.isMiniaturized { window.deminiaturize(nil) }
        return target
    }

}

struct RoutingPage: View {
    @ObservedObject var browser: Browser
    @ObservedObject private var routing = Routing.shared
    @State private var draft: RoutingDraft?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            AppLinksSection()
            Divider()
            Toggle("Enable link routing", isOn: Binding(
                get: { routing.config.enabled }, set: { routing.setEnabled($0) }))
                .disabled(routing.config.hasDuplicateRules)
            if routing.config.hasDuplicateRules {
                Text("Routing is paused. Some saved rules use the same domain and port. Remove the extra rules or edit their domains and ports before enabling routing.")
                    .font(.system(size: 12)).foregroundStyle(.orange)
            }
            Text("Domains include their subdomains; localhost and loopback hosts match exactly. Blank ports match all ports. The most specific enabled rule wins. External links always use the rule destination.")
                .font(.system(size: 12)).foregroundStyle(Palette.muted)
            Picker("Links opened inside Search", selection: Binding(
                get: { routing.config.internalPolicy }, set: { routing.setInternalPolicy($0) })) {
                ForEach(InternalRoutingPolicy.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            if !browser.prefs.usesSpaces {
                Text("With Spaces off, routing can open only a profile’s home Space.")
                    .font(.system(size: 12)).foregroundStyle(.orange)
            }
            Text("Shared by all profiles. Changes here apply everywhere. Each rule chooses one destination profile and Space.")
                .font(.system(size: 12)).foregroundStyle(Palette.muted)
            Button("Add rule") { draft = RoutingDraft() }
            Divider()
            ForEach(routing.config.rules) { rule in
                HStack(spacing: 10) {
                    Toggle("Enable \(rule.hostLabel)", isOn: Binding(
                        get: { routing.config.rules.first { $0.id == rule.id }?.enabled ?? false },
                        set: { routing.setRuleEnabled(rule.id, $0) }))
                        .labelsHidden().accessibilityLabel("Enable \(rule.hostLabel)")
                    VStack(alignment: .leading, spacing: 3) {
                        Text(rule.hostLabel).font(.system(size: 13, weight: .medium))
                        if let profile = Profiles.shared.list.first(where: { $0.id == rule.destinationProfile }),
                           let space = Spaces.read(profile: profile.id).first(where: { $0.id == rule.spaceID }) {
                            Text("\(profile.name) → \(space.name)").font(.system(size: 12)).foregroundStyle(Palette.muted)
                        } else {
                            Text("Missing space: \(rule.spaceName)").font(.system(size: 12)).foregroundStyle(.orange)
                        }
                    }
                    Spacer()
                    Button("Edit") { draft = RoutingDraft(ruleID: rule.id, domain: rule.domain, port: rule.port.map(String.init) ?? "", destination: rule.spaceID, destinationProfile: rule.destinationProfile, internalPolicy: rule.internalPolicy) }
                        .accessibilityLabel("Edit \(rule.hostLabel)")
                    Button { routing.remove(rule.id) } label: {
                        Image(systemName: "trash")
                    }.help("Remove \(rule.hostLabel)").accessibilityLabel("Remove \(rule.hostLabel)")
                }
            }
            if routing.config.rules.isEmpty {
                Text("No routing rules. External links open in the current space.")
                    .font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
        }
        .foregroundStyle(Palette.ink)
        .sheet(item: $draft) { draft in
            RoutingEditor(browser: browser, draft: draft)
        }
    }
}

private struct RoutingDraft: Identifiable {
    let id = UUID()
    var ruleID: UUID?
    var domain = ""
    var port = ""
    var destination: UUID?
    var destinationProfile: UUID?
    var internalPolicy: InternalRoutingOverride = .inherit
}

private struct RoutingEditor: View {
    @ObservedObject var browser: Browser
    @ObservedObject private var routing = Routing.shared
    @Environment(\.dismiss) private var dismiss
    private let editing: UUID?
    @State private var domain: String
    @State private var port: String
    @ObservedObject private var profiles = Profiles.shared
    @State private var destination: UUID?
    @State private var destinationProfile: UUID
    @State private var internalPolicy: InternalRoutingOverride

    init(browser: Browser, draft: RoutingDraft) {
        self.browser = browser
        editing = draft.ruleID
        _domain = State(initialValue: draft.domain)
        _port = State(initialValue: draft.port)
        _destinationProfile = State(initialValue: draft.destinationProfile ?? browser.profileID)
        _destination = State(initialValue: draft.destination)
        _internalPolicy = State(initialValue: draft.internalPolicy)
    }

    private var destinationSpaces: [Space] {
        guard profiles.list.contains(where: { $0.id == destinationProfile }) else { return [] }
        return Spaces.read(profile: destinationProfile)
    }
    private var selectedSpace: Space? { destinationSpaces.first { $0.id == destination } }
    private var valid: Bool {
        guard let normalized = RoutingConfig.domain(domain), selectedSpace != nil, port.isEmpty || RoutingConfig.port(port) != nil else { return false }
        return !routing.config.rules.contains { $0.domain == normalized && $0.port == RoutingConfig.port(port) && $0.id != editing }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(editing == nil ? "Add rule" : "Edit rule").font(.system(size: 13, weight: .semibold))
            Text("Host/domain").font(.system(size: 12, weight: .medium))
            TextField("Host/domain, for example github.com or localhost", text: $domain)
                .textFieldStyle(.roundedBorder).accessibilityLabel("Routing host/domain")
            Text("Port").font(.system(size: 12, weight: .medium))
            TextField("Blank for all ports", text: $port)
                .textFieldStyle(.roundedBorder).accessibilityLabel("Routing port")
            Picker("Profile", selection: $destinationProfile) {
                ForEach(profiles.list) { Text($0.name).tag($0.id) }
                if !profiles.list.contains(where: { $0.id == destinationProfile }) {
                    Text("Missing profile — choose another").tag(destinationProfile)
                }
            }
            .onChange(of: destinationProfile) { _, _ in destination = destinationSpaces.first?.id }
            Picker("Space", selection: $destination) {
                Text("Choose a space").tag(nil as UUID?)
                ForEach(destinationSpaces) { space in Text(space.name).tag(Optional(space.id)) }
                if let destination, selectedSpace == nil {
                    Text("Missing space — choose another").tag(Optional(destination))
                }
            }
            Picker("Internal links", selection: $internalPolicy) {
                ForEach(InternalRoutingOverride.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            if !domain.isEmpty && !valid {
                Text("Enter a host without a URL, path, port or wildcard, and choose a space. Port must be blank or 1–65535. Each host and port combination can appear once.")
                    .font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
            HStack {
                Button(editing == nil ? "Add rule" : "Save rule") {
                    if let space = selectedSpace, routing.save(id: editing, domain: domain, port: RoutingConfig.port(port), space: space, internalPolicy: internalPolicy) { dismiss() }
                }.disabled(!valid)
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
        .frame(width: 390)
        .foregroundStyle(Palette.ink)
    }
}

extension Browser {
    /// Returns true when the original operation is held or cancelled. Only
    /// callers that represent a user's navigation ask this question.
    func routeInternal(_ url: URL, from source: Tab?, foreground: Bool,
                       current: @escaping () -> Void) -> Bool {
        guard source?.shy != true,
              let rule = Routing.shared.config.match(url) else { return false }
        let policy = Routing.shared.config.policy(for: rule)
        guard policy != .current else { return false }
        let originalSpace = spaceID
        let sourceID = source?.id
        let destinations = Profiles.shared.list.flatMap { Spaces.read(profile: $0.id) }
        let destination = destinations.first { $0.id == rule.spaceID && $0.profileID == rule.destinationProfile }
        if policy == .destination, destination?.id == originalSpace { return false }
        let open: (UUID?) -> Void = { [weak self] chosen in
            guard let self, let chosen else { return }
            guard self.spaceID == originalSpace,
                  sourceID == nil || self.tabs.contains(where: { $0.id == sourceID }) else {
                self.announce("Link not opened: the original tab or Space changed")
                return
            }
            if chosen == originalSpace { current(); return }
            guard let space = destinations.first(where: { $0.id == chosen }),
                  let target = Routing.browser(for: space.id, profileID: space.profileID, from: self, foreground: foreground) else {
                self.announce("Link not opened: choose an existing destination in Settings → Routing")
                return
            }
            target.open(url, foreground: foreground, mayWait: true)
            if foreground && target !== self { Browsers.show(target) }
            if !foreground && target === self { self.switchSpace(to: originalSpace) }
        }
        if policy == .destination {
            guard let destination else {
                announce("Link not opened: choose an existing destination in Settings → Routing")
                return true
            }
            open(destination.id)
            return true
        }
        guard !routingQuestionOpen else {
            announce("Link not opened: answer the open-link question first")
            return true
        }
        routingQuestionOpen = true
        let alert = NSAlert()
        alert.messageText = "Where should this link open?"
        alert.informativeText = url.absoluteString
        alert.addButton(withTitle: "Open")
        alert.addButton(withTitle: "Cancel")
        let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 280, height: 26))
        picker.addItem(withTitle: "Current Space (\(space.name))")
        let choices = [originalSpace] + destinations.map(\.id)
        for space in destinations {
            picker.addItem(withTitle: "\(Profiles.shared.profile(space.profileID).name) → \(space.name)")
        }
        if let destination, let index = destinations.firstIndex(where: { $0.id == destination.id }) {
            picker.selectItem(at: index + 1)
        }
        alert.accessoryView = picker
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] answer in
            self?.routingQuestionOpen = false
            guard answer == .alertFirstButtonReturn, choices.indices.contains(picker.indexOfSelectedItem) else { return }
            open(choices[picker.indexOfSelectedItem])
        }
        if let source { Dialogs.show(alert, over: source.web, then: finish) }
        else if Store.testing { finish(.cancel) }
        else if let window = NSApp.mainWindow { alert.beginSheetModal(for: window, completionHandler: finish) }
        else { finish(alert.runModal()) }
        return true
    }

    func navigateInternal(_ url: URL, in source: Tab?) {
        guard let source else { return }
        if !routeInternal(url, from: source, foreground: true, current: { [weak source] in source?.go(to: url) }) {
            source.go(to: url)
        }
    }

    func openInternal(_ url: URL, foreground: Bool, from source: Tab?, mayWait: Bool = false, link: Bool = false) {
        let current = { [weak self, weak source] in
            self?.open(url, foreground: foreground, from: source, mayWait: mayWait, link: link)
            return ()
        }
        if !routeInternal(url, from: source, foreground: foreground, current: current) { current() }
    }
}

/// Where a routing rule sends what Return would open, when that is not
/// here: its Space, or a question for an Ask rule.
struct RouteAhead: Equatable {
    let space: Space?
    let label: String
    let asks: Bool
}

extension Browser {
    /// The rule's destination for the address Return would open, as
    /// routeInternal would answer it: nil where the link stays here.
    var routeAhead: RouteAhead? {
        guard active?.shy != true, let url = addressAhead,
              let rule = Routing.shared.config.match(url) else { return nil }
        let policy = Routing.shared.config.policy(for: rule)
        guard policy != .current else { return nil }
        let profile = rule.destinationProfile
        // This window's own Spaces are at hand; another profile's are read.
        let space = (profile == profileID ? spaces : Spaces.read(profile: profile))
            .first { $0.id == rule.spaceID && $0.profileID == profile }
        if policy == .destination, space == nil || space?.id == spaceID { return nil }
        guard policy == .destination, let space else { return RouteAhead(space: nil, label: "Asks where", asks: true) }
        let label = Profiles.shared.several ? "\(Profiles.shared.profile(profile).name) → \(space.name)" : space.name
        return RouteAhead(space: space, label: label, asks: false)
    }
}

/// Beside the address: the profile and Space a rule opens it in.
struct RouteBadge: View {
    let route: RouteAhead

    var body: some View {
        HStack(spacing: 6) {
            Group {
                if let space = route.space {
                    SpaceIcon(symbol: space.symbol, picture: space.picture, size: 13)
                } else {
                    Image(systemName: "questionmark.circle")
                }
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Palette.muted)
            .frame(width: 16, height: 16)
            Text(route.label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.horizontal, 7)
        .frame(height: 22)
        .background(Palette.wash, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .help(route.asks ? "Return asks where to open this (Settings → Routing)."
                         : "Return opens this in \(route.label) (Settings → Routing).")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(route.asks ? "Asks where to open" : "Opens in \(route.label)")
    }
}
