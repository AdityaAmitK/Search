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

    /// The tools as the inspector's page runs them: they wait in the page
    /// for the inspector to connect to the one it inspects, about ten
    /// seconds at most, then start, once per page.
    private static let bootstrap: String? = script.map { script in
        """
        (function sdtBoot(tries) {
            if (window.SearchDevTools) return;
            var target = typeof WI !== 'undefined' && (WI.pageTarget || WI.mainTarget);
            if (!target || !target.DOMAgent || typeof InspectorFrontendAPI === 'undefined') {
                if (tries < 200) setTimeout(function () { sdtBoot(tries + 1); }, 50);
                return;
            }
        \(script)
        })(0);
        true;
        """
    }

    /// Puts the tools into the page's inspector, and shows `panel` if one is
    /// named. Asked again, an inspector that already has them only shows the
    /// panel.
    static func mount(_ web: WKWebView, panel: String? = nil) {
        guard bootstrap != nil, let inspector = inspector(of: web) else { return }
        attempt(inspector, panel: panel, tries: 0)
    }

    private static func attempt(_ inspector: NSObject, panel: String?, tries: Int) {
        // About five seconds for WebKit to make the inspector's page.
        guard tries < 100, let bootstrap else { return }
        let retry = {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { attempt(inspector, panel: panel, tries: tries + 1) }
        }
        // A closed inspector's page can still be handed back for a moment,
        // out of any window: the one to use is the one on screen.
        let get = NSSelectorFromString("inspectorWebView")
        guard inspector.responds(to: get),
              let front = inspector.perform(get)?.takeUnretainedValue() as? WKWebView,
              front.window != nil
        else { return retry() }
        // Opened again, the inspector loads its page again, sometimes just
        // after this runs on the old one, which still has the tools: once
        // they had been put in by hand, the second opening showed WebKit's
        // own UI. Every load of its page now gets them.
        let scripts = front.configuration.userContentController
        if !scripts.userScripts.contains(where: { $0.source == bootstrap }) {
            scripts.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        // The panel asked for is the one the tools open on, by the page there
        // now or by one loaded a moment later.
        var run = bootstrap
        if let panel, panel.allSatisfy(\.isLetter) {
            run = "try { localStorage.setItem('sdt.panel', JSON.stringify('\(panel)')); } catch {}\n" + run
                + "\nwindow.SearchDevTools && SearchDevTools.show('\(panel)'); true;"
        }
        front.evaluateJavaScript(run, completionHandler: nil)
    }
}
