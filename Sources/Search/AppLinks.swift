import AppKit
import SwiftUI

// Links that belong to an app on this Mac rather than to a tab: YouTube in
// Streamy, a Linear issue in Linear. Each rule names the app, the sites it
// takes and, when the app wants its own kind of link, how to write one
// (linear://…); and where it applies — links from other apps, addresses
// typed into the field, links clicked in a page. Return in the field sends
// a matching address to its app; ⌥Return keeps it here, ⌘Return opens it
// in a new tab here. A link never goes back to the app it came from.
//
// An app can say for itself which sites it takes, in
// ~/Library/Application Support/<its bundle id>/search-links.json, as
// {"hosts": ["youtube.com", …]}; a rule that follows the app reads that and
// falls back to its own list when the app hasn't written one. Streamy does,
// so a source added there routes here without a word in Settings.

struct AppLink: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    /// The app, by its path: /Applications/Streamy.app.
    var app: String
    /// Sites, each with its subdomains.
    var domains: [String] = []
    /// The app's own list of sites when it publishes one; `domains` until then.
    var followsApp = false
    /// A regular expression the page's path must match, or blank for any.
    var paths = ""
    /// The app's link for a page, with {url}, {host}, {path}, {query} and
    /// {fragment} in it; blank hands the app the address as it is.
    var deepLink = ""
    var fromApps = true
    var fromAddress = true
    var fromPages = false
    var enabled = true

    init(name: String, app: String, domains: [String] = [], followsApp: Bool = false, paths: String = "",
         deepLink: String = "", fromApps: Bool = true, fromAddress: Bool = true, fromPages: Bool = false, enabled: Bool = true) {
        self.name = name; self.app = app; self.domains = domains; self.followsApp = followsApp; self.paths = paths
        self.deepLink = deepLink; self.fromApps = fromApps; self.fromAddress = fromAddress; self.fromPages = fromPages; self.enabled = enabled
    }

    enum CodingKeys: String, CodingKey { case id, name, app, domains, followsApp, paths, deepLink, fromApps, fromAddress, fromPages, enabled }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        name = try values.decode(String.self, forKey: .name)
        app = try values.decode(String.self, forKey: .app)
        domains = try values.decodeIfPresent([String].self, forKey: .domains) ?? []
        followsApp = try values.decodeIfPresent(Bool.self, forKey: .followsApp) ?? false
        paths = try values.decodeIfPresent(String.self, forKey: .paths) ?? ""
        deepLink = try values.decodeIfPresent(String.self, forKey: .deepLink) ?? ""
        fromApps = try values.decodeIfPresent(Bool.self, forKey: .fromApps) ?? true
        fromAddress = try values.decodeIfPresent(Bool.self, forKey: .fromAddress) ?? true
        fromPages = try values.decodeIfPresent(Bool.self, forKey: .fromPages) ?? false
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }

    /// A domain as a rule keeps it: lower case, no scheme, path, port or www.
    static func domain(_ text: String) -> String? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let scheme = value.range(of: "://") { value = String(value[scheme.upperBound...]) }
        value = String(value.prefix { $0 != "/" && $0 != ":" && $0 != "?" && $0 != "#" })
        while value.hasSuffix(".") { value.removeLast() }
        if value.hasPrefix("*.") { value.removeFirst(2) }
        guard !value.isEmpty, value.contains("."), value.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" })
        else { return nil }
        return value
    }
}

@MainActor
final class AppLinks: ObservableObject {
    static let shared = AppLinks()

    enum Scope { case apps, address, pages }

    @Published private(set) var links: [AppLink]

    private static let key = "appLinks"

    /// What Streamy and Linear were before this list: the switches in
    /// Settings › Routing, kept as they were set.
    static let streamy = AppLink(
        name: "Streamy", app: "/Applications/Streamy.app",
        domains: ["youtube.com", "youtu.be", "netflix.com", "sonyliv.com", "primevideo.com",
                  "zee5.com", "hotstar.com", "jiohotstar.com", "fancode.com"],
        followsApp: true, fromPages: true)
    static let linear = AppLink(
        name: "Linear", app: "/Applications/Linear.app", domains: ["linear.app"],
        paths: "^/[^/]+/(issue|issues|project|projects|team|view|views|document|docs|initiative|initiatives|inbox|my-issues|cycle|cycles|roadmap|settings|search|customers|customer|reviews|review|pulse|dashboards)(/|$)",
        deepLink: "linear://{path}{query}{fragment}")

    private init() {
        if let data = Store.settings.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode([AppLink].self, from: data) {
            links = saved
        } else {
            var streamy = Self.streamy
            streamy.enabled = Store.settings.bool(forKey: "external.streamy")
            var linear = Self.linear
            linear.enabled = Store.settings.object(forKey: "external.linear") as? Bool ?? true
            links = [streamy, linear]
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(links) { Store.settings.set(data, forKey: Self.key) }
    }

    func save(_ link: AppLink) {
        if let index = links.firstIndex(where: { $0.id == link.id }) { links[index] = link } else { links.append(link) }
        persist()
    }

    func remove(_ id: UUID) {
        links.removeAll { $0.id == id }
        persist()
    }

    func setEnabled(_ id: UUID, _ on: Bool) {
        guard let index = links.firstIndex(where: { $0.id == id }) else { return }
        links[index].enabled = on
        persist()
    }

    func move(from: IndexSet, to: Int) {
        links.move(fromOffsets: from, toOffset: to)
        persist()
    }

    // MARK: - matching

    /// The rule a link goes to, and the link its app is handed: nil when it
    /// stays here. `sender` is the bundle id of the app the link came from.
    func match(_ url: URL, scope: Scope, sender: String? = nil) -> (link: AppLink, target: URL)? {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host?.lowercased() else { return nil }
        for link in links where link.enabled && applies(link, scope) {
            guard covers(link, host: host), pathMatches(link, url) else { continue }
            guard let bundle = Self.bundle(link.app) else { continue }
            if let sender, sender == bundle.bundleIdentifier { return nil }
            guard let target = link.deepLink.isEmpty ? url : Self.fill(link.deepLink, with: url) else { continue }
            return (link, target)
        }
        return nil
    }

    /// Whether a page is already on one of the rule's sites: a link clicked
    /// there is the site's own business, kept in the tab.
    func covers(_ link: AppLink, page: URL?) -> Bool {
        guard let host = page?.host?.lowercased() else { return false }
        return covers(link, host: host)
    }

    private func applies(_ link: AppLink, _ scope: Scope) -> Bool {
        switch scope {
        case .apps: link.fromApps
        case .address: link.fromAddress
        case .pages: link.fromPages
        }
    }

    private func covers(_ link: AppLink, host: String) -> Bool {
        let bare = host.hasSuffix(".") ? String(host.dropLast()) : host
        return domains(of: link).contains { bare == $0 || bare.hasSuffix("." + $0) }
    }

    private var expressions: [String: NSRegularExpression] = [:]

    private func pathMatches(_ link: AppLink, _ url: URL) -> Bool {
        let pattern = link.paths.trimmingCharacters(in: .whitespaces)
        guard !pattern.isEmpty else { return true }
        let expression = expressions[pattern] ?? (try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]))
        guard let expression else { return false }
        expressions[pattern] = expression
        let path = url.path(percentEncoded: true).isEmpty ? "/" : url.path(percentEncoded: true)
        return expression.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil
    }

    /// A rule's sites: the app's own list when it follows the app and the
    /// app has written one, else the rule's.
    func domains(of link: AppLink) -> [String] {
        guard link.followsApp, let published = published(by: link) else { return link.domains }
        return published
    }

    /// Whether the app has said which sites it takes.
    func publishes(_ link: AppLink) -> Bool { published(by: link) != nil }

    private var listed: [String: (date: Date, hosts: [String])] = [:]

    private func published(by link: AppLink) -> [String]? {
        guard let id = Self.bundle(link.app)?.bundleIdentifier,
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let file = support.appendingPathComponent(id).appendingPathComponent("search-links.json")
        guard let date = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date else { return nil }
        if let cached = listed[file.path], cached.date == date { return cached.hosts }
        struct List: Decodable { var hosts: [String] }
        guard let data = try? Data(contentsOf: file), let list = try? JSONDecoder().decode(List.self, from: data) else { return nil }
        let hosts = list.hosts.compactMap(AppLink.domain)
        listed[file.path] = (date, hosts)
        return hosts
    }

    /// The deep link for a page: the template with the page's parts in it.
    static func fill(_ template: String, with url: URL) -> URL? {
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var path = url.path(percentEncoded: true)
        if path.hasPrefix("/") { path.removeFirst() }
        let query = parts?.percentEncodedQuery.map { "?" + $0 } ?? ""
        let fragment = parts?.percentEncodedFragment.map { "#" + $0 } ?? ""
        let text = template
            .replacingOccurrences(of: "{url}", with: url.absoluteString)
            .replacingOccurrences(of: "{host}", with: url.host ?? "")
            .replacingOccurrences(of: "{path}", with: path)
            .replacingOccurrences(of: "{query}", with: query)
            .replacingOccurrences(of: "{fragment}", with: fragment)
        return URL(string: text)
    }

    // MARK: - the apps

    private static var bundles: [String: Bundle] = [:]

    static func bundle(_ path: String) -> Bundle? {
        if let known = bundles[path] { return known }
        guard FileManager.default.fileExists(atPath: path), let bundle = Bundle(path: path) else { return nil }
        bundles[path] = bundle
        return bundle
    }

    private static var icons: [String: NSImage] = [:]

    static func icon(_ link: AppLink) -> NSImage {
        if let icon = icons[link.app] { return icon }
        let icon = NSWorkspace.shared.icon(forFile: link.app)
        icons[link.app] = icon
        return icon
    }

    /// Hands the link to the rule's app. `fallback` runs when the app is
    /// missing or macOS can't open it.
    func launch(_ target: URL, in link: AppLink, fallback: @escaping @MainActor () -> Void) {
        guard !Store.testing, FileManager.default.fileExists(atPath: link.app) else { fallback(); return }
        // Aimed at the app itself, so macOS can't send it back here.
        NSWorkspace.shared.open([target], withApplicationAt: URL(fileURLWithPath: link.app, isDirectory: true),
                                configuration: .init()) { _, error in
            guard error != nil else { return }
            DispatchQueue.main.async { fallback() }
        }
    }
}

// MARK: - in the field

/// The app an address will open in, beside what is typed: its icon and
/// name, and the key that keeps it here instead.
struct AppLinkBadge: View {
    let link: AppLink
    var body: some View {
        HStack(spacing: 6) {
            Image(nsImage: AppLinks.icon(link))
                .resizable()
                .interpolation(.high)
                .frame(width: 16, height: 16)
            Text(link.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .fixedSize()
            Text("⌥↩ here")
                .font(.system(size: 11))
                .foregroundStyle(Palette.muted)
                .fixedSize()
        }
        .padding(.horizontal, 7)
        .frame(height: 22)
        .background(Palette.wash, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .help("Return opens this in \(link.name). ⌥Return opens it here; ⌘Return in a new tab here.")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Opens in \(link.name). Option-Return opens it in Search.")
    }
}

extension Browser {
    /// Where Return would go right now, without going: the picked row, the
    /// address being finished, or what was typed. Nil for an open tab or a
    /// command.
    var addressAhead: URL? {
        if let picked, offers.indices.contains(picked) {
            let offer = offers[picked]
            if offer.tab != nil { return nil }
            if case .command = offer.kind { return nil }
            return offer.url
        }
        if case .command = offers.first?.kind { return nil }
        if ending != nil { return Address.url(from: completed) }
        guard !typed.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return destination(for: typed)
    }

    /// The app Return would hand the address to.
    var appAhead: AppLink? {
        addressAhead.flatMap { AppLinks.shared.match($0, scope: .address)?.link }
    }

    /// The address to its app, if a rule takes it: true when it went.
    /// `otherwise` opens it here, should the app not.
    func handToApp(_ url: URL, otherwise: @escaping @MainActor () -> Void) -> Bool {
        guard let (link, target) = AppLinks.shared.match(url, scope: .address) else { return false }
        AppLinks.shared.launch(target, in: link, fallback: otherwise)
        return true
    }
}

// MARK: - Settings

struct AppLinksSection: View {
    @ObservedObject private var appLinks = AppLinks.shared
    @State private var draft: AppLink?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Open in apps").font(.system(size: 13, weight: .semibold))
            Text("Links to these sites open in their apps: from other apps, from the address field, and, where turned on, from links clicked in a page. In the address field ⌥Return opens the page here instead, and ⌘Return in a new tab here. ⌘-click a link to keep it here.")
                .font(.system(size: 12)).foregroundStyle(Palette.muted)
            ForEach(appLinks.links) { link in
                HStack(spacing: 10) {
                    Toggle("Open \(link.name) links in \(link.name)", isOn: Binding(
                        get: { appLinks.links.first { $0.id == link.id }?.enabled ?? false },
                        set: { appLinks.setEnabled(link.id, $0) }))
                        .labelsHidden()
                    Image(nsImage: AppLinks.icon(link)).resizable().frame(width: 20, height: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(link.name).font(.system(size: 13, weight: .medium))
                        Text(summary(link)).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(2)
                        if AppLinks.bundle(link.app) == nil {
                            Text("\(link.app) isn’t installed").font(.system(size: 11)).foregroundStyle(.orange)
                        }
                    }
                    Spacer()
                    Button("Edit") { draft = link }
                    Button { appLinks.remove(link.id) } label: { Image(systemName: "trash") }
                        .help("Remove \(link.name)")
                }
            }
            HStack {
                Button("Add app…") {
                    if let app = Self.chooseApp() {
                        draft = AppLink(name: FileManager.default.displayName(atPath: app).replacingOccurrences(of: ".app", with: ""), app: app)
                    }
                }
                if !appLinks.links.contains(where: { $0.app == AppLinks.linear.app }) {
                    Button("Add Linear") { appLinks.save(AppLink(name: AppLinks.linear.name, app: AppLinks.linear.app, domains: AppLinks.linear.domains, paths: AppLinks.linear.paths, deepLink: AppLinks.linear.deepLink)) }
                }
                if !appLinks.links.contains(where: { $0.app == AppLinks.streamy.app }) {
                    Button("Add Streamy") { var streamy = AppLinks.streamy; streamy.id = UUID(); appLinks.save(streamy) }
                }
            }
        }
        .sheet(item: $draft) { link in AppLinkEditor(link: link) }
    }

    private func summary(_ link: AppLink) -> String {
        let domains = appLinks.domains(of: link)
        var text = domains.prefix(4).joined(separator: ", ") + (domains.count > 4 ? " and \(domains.count - 4) more" : "")
        if link.followsApp && appLinks.publishes(link) { text += " · as \(link.name) lists them" }
        let scopes = [link.fromApps ? "other apps" : nil, link.fromAddress ? "address field" : nil, link.fromPages ? "page links" : nil].compactMap { $0 }
        text += " · from " + (scopes.isEmpty ? "nowhere" : scopes.joined(separator: ", "))
        return text
    }

    static func chooseApp() -> String? {
        let panel = NSOpenPanel()
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.canChooseDirectories = false
        panel.prompt = "Choose"
        return panel.runModal() == .OK ? panel.url?.path : nil
    }
}

private struct AppLinkEditor: View {
    @ObservedObject private var appLinks = AppLinks.shared
    @Environment(\.dismiss) private var dismiss
    @State private var link: AppLink
    @State private var domains: String

    init(link: AppLink) {
        _link = State(initialValue: link)
        _domains = State(initialValue: link.domains.joined(separator: ", "))
    }

    private var parsed: [String] {
        domains.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).compactMap { AppLink.domain(String($0)) }
    }
    private var pathsValid: Bool {
        link.paths.trimmingCharacters(in: .whitespaces).isEmpty || (try? NSRegularExpression(pattern: link.paths)) != nil
    }
    private var deepLinkValid: Bool {
        link.deepLink.isEmpty || AppLinks.fill(link.deepLink, with: URL(string: "https://example.com/a/b?c=d#e")!) != nil
    }
    private var valid: Bool {
        !link.name.trimmingCharacters(in: .whitespaces).isEmpty && AppLinks.bundle(link.app) != nil
            && (!parsed.isEmpty || (link.followsApp && appLinks.publishes(link))) && pathsValid && deepLinkValid
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(nsImage: AppLinks.icon(link)).resizable().frame(width: 32, height: 32)
                VStack(alignment: .leading) {
                    TextField("Name", text: $link.name).textFieldStyle(.roundedBorder)
                    Text(link.app).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle)
                }
                Button("Change…") { if let app = AppLinksSection.chooseApp() { link.app = app } }
            }
            Text("Sites").font(.system(size: 12, weight: .medium))
            TextField("youtube.com, youtu.be", text: $domains, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(1...4)
            Toggle("Use the sites \(link.name) lists for itself, when it does", isOn: $link.followsApp)
            if link.followsApp {
                Text(appLinks.publishes(link)
                     ? "\(link.name) lists: \(appLinks.domains(of: link).joined(separator: ", "))"
                     : "\(link.name) hasn’t listed any; the sites above are used.")
                    .font(.system(size: 11)).foregroundStyle(Palette.muted)
            }
            Text("Only these paths (regular expression, optional)").font(.system(size: 12, weight: .medium))
            TextField("^/watch", text: $link.paths).textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
            Text("App link (optional)").font(.system(size: 12, weight: .medium))
            TextField("Blank sends the address itself, e.g. linear://{path}{query}", text: $link.deepLink)
                .textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
            Text("{url}, {host}, {path}, {query} and {fragment} are filled in from the page.")
                .font(.system(size: 11)).foregroundStyle(Palette.muted)
            Text("Open in \(link.name)").font(.system(size: 12, weight: .medium))
            Toggle("Links from other apps", isOn: $link.fromApps)
            Toggle("Addresses typed in the address field", isOn: $link.fromAddress)
            Toggle("Links clicked in a page on another site", isOn: $link.fromPages)
            if !pathsValid { Text("That path pattern isn’t a valid regular expression.").font(.system(size: 11)).foregroundStyle(.orange) }
            HStack {
                Button(appLinks.links.contains(where: { $0.id == link.id }) ? "Save" : "Add") {
                    link.domains = parsed
                    link.name = link.name.trimmingCharacters(in: .whitespaces)
                    appLinks.save(link)
                    dismiss()
                }
                .disabled(!valid)
                .keyboardShortcut(.defaultAction)
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
        .frame(width: 440)
        .foregroundStyle(Palette.ink)
    }
}
