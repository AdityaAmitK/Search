import XCTest
@testable import Search

final class RoutingTests: XCTestCase {
    func testDomainsAreNormalizedAndRejectURLsAndInvalidLabels() {
        XCTAssertEqual(RoutingConfig.domain(" Example.COM. \n"), "example.com")
        for input in ["https://example.com", "example.com/path", "example.com:443", "*.example.com",
                      "example..com", "-example.com", "example-.com", "127.0.0.1", "localhost",
                      String(repeating: "a", count: 64) + ".com"] {
            XCTAssertNil(RoutingConfig.domain(input), input)
        }
    }

    func testMostSpecificEnabledDomainWinsWithoutMatchingLookalikes() {
        let broad = RoutingRule(domain: "example.com", spaceID: UUID(), spaceName: "Work")
        let narrow = RoutingRule(domain: "docs.example.com", spaceID: UUID(), spaceName: "Research")
        var config = RoutingConfig(enabled: true, rules: [narrow, broad])
        XCTAssertEqual(config.match(URL(string: "https://a.docs.example.com/page")!), narrow)
        XCTAssertEqual(config.match(URL(string: "https://example.com")!), broad)
        XCTAssertNil(config.match(URL(string: "https://notexample.com")!))
        XCTAssertNil(config.match(URL(string: "https://example.com.invalid")!))
        XCTAssertNil(config.match(URL(string: "ftp://example.com")!))
        config.rules[0].enabled = false
        XCTAssertEqual(config.match(URL(string: "https://docs.example.com")!), broad)
        config.enabled = false
        XCTAssertNil(config.match(URL(string: "https://example.com")!))
    }

    @MainActor
    func testPersistenceStartsDisabledAndEmptyAndKeepsEmptyAndCorruptSettingsSafe() throws {
        let suite = "Search.routing.tests." + UUID().uuidString
        let settings = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { settings.removePersistentDomain(forName: suite) }
        let routing = Routing(settings: settings)
        XCTAssertEqual(routing.config, RoutingConfig(enabled: false, rules: []))
        let space = Space(id: UUID(), name: "Personal", colour: 0)
        XCTAssertTrue(routing.save(id: nil, domain: "EXAMPLE.COM", space: space))
        XCTAssertFalse(routing.save(id: nil, domain: "example.com", space: space))
        routing.setEnabled(true)
        let restored = Routing(settings: settings)
        XCTAssertEqual(restored.config, routing.config)
        XCTAssertEqual(restored.config.rules.first?.spaceID, space.id)
        restored.remove(try XCTUnwrap(restored.config.rules.first?.id))
        XCTAssertTrue(Routing(settings: settings).config.rules.isEmpty)
        settings.set(Data("invalid".utf8), forKey: Routing.key)
        XCTAssertEqual(Routing(settings: settings).config, RoutingConfig())
    }
    func testOlderJSONKeepsEnabledRulesAndDefaultsInternalRouting() throws {
        let ruleID = UUID(), spaceID = UUID()
        let json = """
        {"enabled":true,"rules":[{"id":"\(ruleID)","domain":"example.com",
        "spaceID":"\(spaceID)","spaceName":"Personal","enabled":false}]}
        """
        let config = try JSONDecoder().decode(RoutingConfig.self, from: Data(json.utf8))
        XCTAssertTrue(config.enabled)
        XCTAssertEqual(config.internalPolicy, .current)
        XCTAssertEqual(config.rules.count, 1)
        XCTAssertEqual(config.rules[0].id, ruleID)
        XCTAssertEqual(config.rules[0].spaceID, spaceID)
        XCTAssertFalse(config.rules[0].enabled)
        XCTAssertEqual(config.rules[0].internalPolicy, .inherit)
        XCTAssertEqual(try JSONDecoder().decode(RoutingConfig.self, from: JSONEncoder().encode(config)), config)
    }

    func testInternalOverrideDoesNotChangeExternalMatch() {
        var rule = RoutingRule(domain: "example.com", spaceID: UUID(), spaceName: "Work")
        var config = RoutingConfig(enabled: true, rules: [rule], internalPolicy: .ask)
        XCTAssertEqual(config.policy(for: rule), .ask)
        for policy in InternalRoutingOverride.allCases {
            rule.internalPolicy = policy
            config.rules = [rule]
            XCTAssertEqual(config.policy(for: rule), InternalRoutingPolicy(rawValue: policy.rawValue) ?? .ask)
            XCTAssertEqual(config.match(URL(string: "https://example.com")!)?.spaceID, rule.spaceID)
        }
        config.enabled = false
        XCTAssertNil(config.match(URL(string: "https://example.com")!))
    }

}
