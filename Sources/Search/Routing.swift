import SwiftUI

struct RoutingRule: Codable, Identifiable, Equatable {
    var id = UUID()
    var domain: String
    var spaceID: UUID
    var spaceName: String
    var enabled = true
}

struct RoutingConfig: Codable, Equatable {
    var enabled = false
    var rules: [RoutingRule] = []

    static func domain(_ input: String) -> String? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.hasSuffix(".") { text.removeLast() }
        guard text.count <= 253, text.contains("."), text.allSatisfy({
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == ".")
        }) else { return nil }
        let labels = text.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ label in
            !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
        }), labels.last?.contains(where: { $0.isLetter }) == true else { return nil }
        return text
    }

    func match(_ url: URL) -> RoutingRule? {
        guard enabled, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host.flatMap(Self.domain) else { return nil }
        return rules.filter { rule in
            rule.enabled && Self.domain(rule.domain) == rule.domain &&
                (host == rule.domain || host.hasSuffix("." + rule.domain))
        }.max { $0.domain.count < $1.domain.count }
    }
}

@MainActor
final class Routing: ObservableObject {
    static let shared = Routing()
    static let key = "external.routing"
    @Published private(set) var config: RoutingConfig

    init(settings: UserDefaults = Store.settings) {
        self.settings = settings
        config = settings.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode(RoutingConfig.self, from: $0) }
            ?? RoutingConfig()
    }

    private let settings: UserDefaults

    private func persist() {
        if let data = try? JSONEncoder().encode(config) { settings.set(data, forKey: Self.key) }
    }

    func setEnabled(_ enabled: Bool) { config.enabled = enabled; persist() }
    func setRuleEnabled(_ id: UUID, _ enabled: Bool) {
        guard let index = config.rules.firstIndex(where: { $0.id == id }) else { return }
        config.rules[index].enabled = enabled
        persist()
    }
    func remove(_ id: UUID) { config.rules.removeAll { $0.id == id }; persist() }
    @discardableResult
    func save(id: UUID?, domain input: String, space: Space) -> Bool {
        guard let domain = RoutingConfig.domain(input),
              !config.rules.contains(where: { $0.domain == domain && $0.id != id }) else { return false }
        if let id, let index = config.rules.firstIndex(where: { $0.id == id }) {
            config.rules[index].domain = domain
            config.rules[index].spaceID = space.id
            config.rules[index].spaceName = space.name
        } else {
            config.rules.append(RoutingRule(domain: domain, spaceID: space.id, spaceName: space.name))
        }
        persist()
        return true
    }
}

struct RoutingPage: View {
    @ObservedObject var browser: Browser
    @ObservedObject private var routing = Routing.shared
    @State private var draft: RoutingDraft?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Toggle("Route links from other apps", isOn: Binding(
                get: { routing.config.enabled }, set: { routing.setEnabled($0) }))
            Text("Domains include their subdomains. The most specific enabled rule wins. Links clicked inside Search stay in their current space.")
                .font(.system(size: 12)).foregroundStyle(Palette.muted)
            if !browser.prefs.usesSpaces {
                Text("Enable Spaces in Tabs to open routed links. Until then, matching links are blocked.")
                    .font(.system(size: 12)).foregroundStyle(.orange)
            }
            Button("Add rule") { draft = RoutingDraft() }
            Divider()
            ForEach(routing.config.rules) { rule in
                HStack(spacing: 10) {
                    Toggle("Enable \(rule.domain)", isOn: Binding(
                        get: { routing.config.rules.first { $0.id == rule.id }?.enabled ?? false },
                        set: { routing.setRuleEnabled(rule.id, $0) }))
                        .labelsHidden().accessibilityLabel("Enable \(rule.domain)")
                    VStack(alignment: .leading, spacing: 3) {
                        Text(rule.domain).font(.system(size: 13, weight: .medium))
                        if let space = browser.spaces.first(where: { $0.id == rule.spaceID }) {
                            Text(space.name).font(.system(size: 12)).foregroundStyle(Palette.muted)
                        } else {
                            Text("Missing space: \(rule.spaceName)").font(.system(size: 12)).foregroundStyle(.orange)
                        }
                    }
                    Spacer()
                    Button("Edit") { draft = RoutingDraft(ruleID: rule.id, domain: rule.domain, destination: rule.spaceID) }
                        .accessibilityLabel("Edit \(rule.domain)")
                    Button { routing.remove(rule.id) } label: {
                        Image(systemName: "trash")
                    }.help("Remove \(rule.domain)").accessibilityLabel("Remove \(rule.domain)")
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
    var destination: UUID?
}

private struct RoutingEditor: View {
    @ObservedObject var browser: Browser
    @ObservedObject private var routing = Routing.shared
    @Environment(\.dismiss) private var dismiss
    private let editing: UUID?
    @State private var domain: String
    @State private var destination: UUID?

    init(browser: Browser, draft: RoutingDraft) {
        self.browser = browser
        editing = draft.ruleID
        _domain = State(initialValue: draft.domain)
        _destination = State(initialValue: draft.destination)
    }

    private var selectedSpace: Space? { browser.spaces.first { $0.id == destination } }
    private var valid: Bool {
        guard let normalized = RoutingConfig.domain(domain), selectedSpace != nil else { return false }
        return !routing.config.rules.contains { $0.domain == normalized && $0.id != editing }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(editing == nil ? "Add rule" : "Edit rule").font(.system(size: 13, weight: .semibold))
            Text("Domain").font(.system(size: 12, weight: .medium))
            TextField("Domain, for example github.com", text: $domain)
                .textFieldStyle(.roundedBorder).accessibilityLabel("Routing domain")
            Picker("Space", selection: $destination) {
                Text("Choose a space").tag(nil as UUID?)
                ForEach(browser.spaces) { space in Text(space.name).tag(Optional(space.id)) }
                if let destination, selectedSpace == nil {
                    Text("Missing space — choose another").tag(Optional(destination))
                }
            }
            if !domain.isEmpty && !valid {
                Text("Enter a domain without a URL, path, port or wildcard, and choose a space. Each domain can appear once.")
                    .font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
            HStack {
                Button(editing == nil ? "Add rule" : "Save rule") {
                    if let space = selectedSpace, routing.save(id: editing, domain: domain, space: space) { dismiss() }
                }.disabled(!valid)
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
        .frame(width: 390)
        .foregroundStyle(Palette.ink)
    }
}
