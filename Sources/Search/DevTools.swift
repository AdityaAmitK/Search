import WebKit

// Search's own developer tools, drawn over WebKit's Web Inspector. The
// inspector is still WebKit's, opened as always (Inspector.swift), with its
// connection to the page; its own page is a web page too, and DevTools/ in
// the app's resources is put into it once it has loaded. From there the tools
// read what the page sends the inspector and ask the inspector's agents for
// the rest — the DOM, styles, console, network, storage. WebKit's own UI stays
// underneath, a menu item away.
//
// The inspector's page is reached through names outside the public framework
// (`inspectorWebView`), asked for before use; a WebKit without them, or an app
// built without DevTools/, leaves WebKit's inspector as it was.

enum DevTools {
    /// The tools, read once: the stylesheet handed to the script as a string.
    private static let script: String? = {
        guard let folder = Bundle.main.resourceURL?.appendingPathComponent("DevTools"),
              let js = try? String(contentsOf: folder.appendingPathComponent("devtools.js"), encoding: .utf8),
              let css = try? String(contentsOf: folder.appendingPathComponent("devtools.css"), encoding: .utf8),
              let quoted = try? JSONSerialization.data(withJSONObject: [css]),
              let literal = String(data: quoted, encoding: .utf8)
        else { return nil }
        return "window.__sdtCSS = \(literal)[0];\n" + js
    }()

    /// The inspector of a page, when this WebKit has one to give.
    static func inspector(of web: WKWebView) -> NSObject? {
        let get = NSSelectorFromString("_inspector")
        guard web.responds(to: get) else { return nil }
        return web.perform(get)?.takeUnretainedValue() as? NSObject
    }

    /// Puts the tools into the page's inspector once its page is ready, and
    /// shows `panel` if one is named. Asked again, an inspector that already
    /// has them only shows the panel.
    static func mount(_ web: WKWebView, panel: String? = nil) {
        guard script != nil, let inspector = inspector(of: web) else { return }
        attempt(inspector, panel: panel, tries: 0)
    }

    private static func attempt(_ inspector: NSObject, panel: String?, tries: Int) {
        // About five seconds for WebKit to make the inspector's page and for
        // that page to connect to the one it inspects.
        guard tries < 100, let script else { return }
        let retry = {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { attempt(inspector, panel: panel, tries: tries + 1) }
        }
        let get = NSSelectorFromString("inspectorWebView")
        guard inspector.responds(to: get),
              let front = inspector.perform(get)?.takeUnretainedValue() as? WKWebView
        else { return retry() }
        let ready = "typeof WI !== 'undefined' && !!(WI.pageTarget || WI.mainTarget) && !!(WI.pageTarget || WI.mainTarget).DOMAgent && typeof InspectorFrontendAPI !== 'undefined' ? (window.SearchDevTools ? 'mounted' : 'ready') : 'waiting'"
        front.evaluateJavaScript(ready) { state, _ in
            switch state as? String {
            case "ready":
                front.evaluateJavaScript(script) { _, _ in show(panel, in: front) }
            case "mounted":
                show(panel, in: front)
            default:
                retry()
            }
        }
    }

    private static func show(_ panel: String?, in front: WKWebView) {
        guard let panel, panel.allSatisfy(\.isLetter) else { return }
        front.evaluateJavaScript("window.SearchDevTools && SearchDevTools.show('\(panel)'); true", completionHandler: nil)
    }
}
