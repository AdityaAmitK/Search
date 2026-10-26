import XCTest
@testable import Search

final class RoutingTests: XCTestCase {
    private func rule(_ domain: String, port: Int? = nil, profile: UUID? = nil,
                      enabled: Bool = true) -> RoutingRule {
        RoutingRule(domain: domain, port: port, spaceID: UUID(), spaceName: "Destination",
                    enabled: enabled, profileID: profile)
    }

    private func url(_ text: String) throws -> URL { try XCTUnwrap(URL(string: text)) }

    func testMostSpecificHostWinsRegardlessOfRuleOrder() throws {
        let broad = rule("example.com"), narrow = rule("docs.example.com")
        for rules in [[broad, narrow], [narrow, broad]] {
            let config = RoutingConfig(enabled: true, rules: rules)
            XCTAssertEqual(config.match(try url("https://api.docs.example.com/a"))?.id, narrow.id)
            XCTAssertEqual(config.match(try url("https://example.com/"))?.id, broad.id)
            XCTAssertEqual(config.match(try url("https://EXAMPLE.COM./"))?.id, broad.id)
            XCTAssertNil(config.match(try url("https://notexample.com/")))
            XCTAssertNil(config.match(try url("https://example.com.evil.test/")))
        }
    }

    func testExactPortWinsAndDefaultPortsAreResolved() throws {
        let fallback = rule("example.com"), https = rule("example.com", port: 443)
        let http = rule("example.com", port: 80), local = rule("example.com", port: 3000)
        for rules in [[fallback, https, http, local], [local, http, https, fallback]] {
            let config = RoutingConfig(enabled: true, rules: rules)
            for address in ["https://example.com/", "https://example.com:443/"] {
                XCTAssertEqual(config.match(try url(address))?.id, https.id)
            }
            XCTAssertEqual(config.match(try url("http://example.com/"))?.id, http.id)
            XCTAssertEqual(config.match(try url("http://example.com:3000/"))?.id, local.id)
            XCTAssertEqual(config.match(try url("https://example.com:8443/"))?.id, fallback.id)
        }
        XCTAssertNil(RoutingConfig(enabled: true, rules: [local]).match(try url("https://example.com/")))
    }

    func testLocalhostAndLoopbacksMatchExactly() throws {
        for host in ["localhost", "127.0.0.1", "::1"] {
            let fallback = rule(host), exact = rule(host, port: 3000)
            let config = RoutingConfig(enabled: true, rules: [fallback, exact])
            let authority = host == "::1" ? "[::1]" : host
            XCTAssertEqual(config.match(try url("http://\(authority):3000/"))?.id, exact.id)
            XCTAssertEqual(config.match(try url("http://\(authority):4000/"))?.id, fallback.id)
            if host != "::1" {
                XCTAssertNil(config.match(try url("http://sub.\(host):3000/")))
            }
        }
    }

    func testAnotherProfilesRuleNeverAppliesEvenIfItIsMoreSpecific() throws {
        let other = UUID()
        let personal = rule("example.com", profile: Profile.personalID)
        let theirs = rule("example.com", profile: other)
        let narrow = rule("docs.example.com", profile: other)
        let config = RoutingConfig(enabled: true, rules: [personal, theirs, narrow])
        XCTAssertEqual(config.match(try url("https://docs.example.com/"), profileID: Profile.personalID)?.id, personal.id)
        XCTAssertEqual(config.match(try url("https://example.com/"), profileID: other)?.id, theirs.id)
        XCTAssertEqual(config.match(try url("https://docs.example.com/"), profileID: other)?.id, narrow.id)
        XCTAssertNil(config.match(try url("https://example.com/"), profileID: UUID()))
    }

    func testLegacyJSONRulesBelongToPersonalAndRetainTheirDestination() throws {
        let id = UUID(), destination = UUID()
        let data = Data("""
        {"enabled":true,"rules":[{"id":"\(id)","domain":"example.com",
        "spaceID":"\(destination)","spaceName":"Legacy"}]}
        """.utf8)
        let config = try JSONDecoder().decode(RoutingConfig.self, from: data)
        let matched = try XCTUnwrap(config.match(try url("https://example.com/"), profileID: Profile.personalID))
        XCTAssertEqual(matched.id, id)
        XCTAssertEqual(matched.spaceID, destination)
        XCTAssertEqual(matched.internalPolicy, .inherit)
        XCTAssertEqual(config.internalPolicy, .current)
        XCTAssertNil(config.match(try url("https://example.com/"), profileID: UUID()))
    }

    func testProfileBindingSurvivesJSONRoundTrip() throws {
        let profile = UUID(), saved = rule("example.com", profile: profile)
        let config = RoutingConfig(enabled: true, rules: [saved])
        let decoded = try JSONDecoder().decode(RoutingConfig.self, from: JSONEncoder().encode(config))
        XCTAssertEqual(decoded.match(try url("https://example.com/"), profileID: profile), saved)
        XCTAssertNil(decoded.match(try url("https://example.com/"), profileID: Profile.personalID))
    }

    func testDisabledEmptyAndNonWebInputsDoNothing() throws {
        let saved = rule("example.com")
        let address = try url("https://example.com/")
        XCTAssertNil(RoutingConfig(rules: [saved]).match(address))
        XCTAssertNil(RoutingConfig(enabled: true).match(address))
        XCTAssertNil(RoutingConfig(enabled: true, rules: [rule("example.com", enabled: false)]).match(address))
        let config = RoutingConfig(enabled: true, rules: [saved])
        for input in ["file:///example.com/", "ftp://example.com/", "mailto:a@example.com"] {
            XCTAssertNil(config.match(try url(input)))
        }
        let legacyDefault = try JSONDecoder().decode(RoutingConfig.self, from: Data("{}".utf8))
        XCTAssertFalse(legacyDefault.enabled)
        XCTAssertTrue(legacyDefault.rules.isEmpty)
    }
}
