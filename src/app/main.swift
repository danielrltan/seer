// Seer.app: one menu-bar app for all of Seer on the Mac.
//   Seer              the app: menu-bar eye (its pupil spins while an agent works), the screen stream and input
//                     (Stream.swift), and the supervisor for the Seer service and the tunnel (Supervisor.swift)
//   Seer wifi ...     the Wi-Fi helper, as a subcommand of the same binary (Wifi.swift)
import AppKit
import ServiceManagement

signal(SIGPIPE, SIG_IGN)
let argv = Array(CommandLine.arguments.dropFirst())
if argv.first == "wifi" { wifiMain(Array(argv.dropFirst())) }

// ---------- the eye, drawn for the menu bar ----------
// A template image (macOS tints it for light or dark menu bars). frame: which spoke leads (0...7); nil = still.
func eyeImage(frame: Int?) -> NSImage {
    let size = NSSize(width: 22, height: 16)
    let img = NSImage(size: size, flipped: false) { rect in
        NSColor.black.setStroke(); NSColor.black.setFill()
        let eye = NSBezierPath()
        eye.move(to: NSPoint(x: 1.5, y: 8))
        eye.curve(to: NSPoint(x: 20.5, y: 8), controlPoint1: NSPoint(x: 6, y: 14.6), controlPoint2: NSPoint(x: 16, y: 14.6))
        eye.curve(to: NSPoint(x: 1.5, y: 8), controlPoint1: NSPoint(x: 16, y: 1.4), controlPoint2: NSPoint(x: 6, y: 1.4))
        eye.lineWidth = 2.6; eye.lineJoinStyle = .round; eye.stroke()
        let c = NSPoint(x: 11, y: 8)
        for i in 0..<8 {
            let a = CGFloat.pi / 2 - CGFloat(i) * .pi / 4
            let lead = frame ?? 0
            let age = (i - lead + 8) % 8                           // 0 = the leading spoke; the trail fades behind it
            let alpha: CGFloat = frame == nil ? 1 : (age == 0 ? 1 : 0.18 + 0.82 * CGFloat(8 - age) / 8)
            NSColor.black.withAlphaComponent(alpha).setStroke()
            let s = NSBezierPath()
            s.move(to: NSPoint(x: c.x + 1.0 * cos(a), y: c.y + 1.0 * sin(a)))
            s.line(to: NSPoint(x: c.x + 2.6 * cos(a), y: c.y + 2.6 * sin(a)))
            s.lineWidth = 1.1; s.lineCapStyle = .round; s.stroke()
        }
        return true
    }
    img.isTemplate = true
    return img
}

// ---------- the app ----------
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private var daemon: Child!, tunnel: Child!
    private var status: [String: Any] = [:]
    private var spin: Timer?, frame = 0

    func applicationDidFinishLaunching(_ note: Notification) {
        // one Seer at a time
        if NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").count > 1 { NSApp.terminate(nil); return }
        try? FileManager.default.createDirectory(at: seerHome.appendingPathComponent("logs"), withIntermediateDirectories: true)

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = eyeImage(frame: nil)
        item.button?.toolTip = "Seer"
        let menu = NSMenu(); menu.delegate = self; item.menu = menu

        // The screen stream lives in the app (its permissions are the app's): ask for Accessibility once, listen.
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
        serve()

        daemon = Child(name: "daemon", exe: Bundled.node, args: [Bundled.seerJs, "daemon"], env: Bundled.env)
        tunnel = Child(name: "tunnel", exe: Bundled.cloudflared,
                       args: ["tunnel", "--no-autoupdate", "run", "--token-file", seerHome.appendingPathComponent("tunnel-token").path], env: Bundled.env)
        daemon.start()
        if FileManager.default.fileExists(atPath: seerHome.appendingPathComponent("tunnel-token").path) { tunnel.start() }

        // Open at login follows the setting (on unless turned off, from Settings or this menu).
        syncLogin()

        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }

    func applicationWillTerminate(_ note: Notification) {
        daemon?.stop(); tunnel?.stop()
    }

    // ---- status from the Seer service ----
    private func poll() {
        syncLogin()
        guard let url = URL(string: "http://127.0.0.1:7399/status.json") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            DispatchQueue.main.async { self?.status = j; self?.updateSpin() }
        }.resume()
    }

    private func updateSpin() {
        let busy = (status["agentsBusy"] as? Int ?? 0) > 0
        if busy && spin == nil {
            spin = Timer.scheduledTimer(withTimeInterval: 0.125, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.frame = (self.frame + 1) % 8
                self.item.button?.image = eyeImage(frame: self.frame)
            }
        } else if !busy, let s = spin {
            s.invalidate(); spin = nil
            item.button?.image = eyeImage(frame: nil)
        }
    }

    // ---- the menu, rebuilt each time it opens ----
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let awake = status["awake"] as? [String: Any] ?? [:]
        let batt = status["battery"] as? [String: Any] ?? [:]
        let net = status["network"] as? [String: Any] ?? [:]
        let info = { (t: String) -> NSMenuItem in let m = NSMenuItem(title: t, action: nil, keyEquivalent: ""); m.isEnabled = false; return m }
        if status.isEmpty {
            menu.addItem(info("Starting…"))
        } else {
            let state = (awake["awake"] as? Bool ?? false) ? ((awake["headless"] as? Bool ?? false) ? "Headless" : "Awake") : "Will sleep"
            menu.addItem(info("\(state): \(awake["why"] as? String ?? "")"))
            let kind = ["wifi": "Wi-Fi", "hotspot": "Hotspot", "wired": "Wired", "offline": "Offline"][net["kind"] as? String ?? ""] ?? "—"
            menu.addItem(info("Battery \(batt["pct"] as? Int ?? 0)%\((batt["pluggedIn"] as? Bool ?? false) ? ", plugged in" : "")  ·  \(kind)  ·  lid \(status["lid"] as? String ?? "?")"))
            let busy = status["agentsBusy"] as? Int ?? 0
            if busy > 0 { menu.addItem(info("\(busy) agent\(busy > 1 ? "s" : "") working")) }
        }
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open Seer", action: #selector(openHome), keyEquivalent: "o"); open.target = self; menu.addItem(open)

        let stay = NSMenuItem(title: "Stay awake", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for (title, minutes) in [("30 minutes", 30), ("1 hour", 60), ("2 hours", 120), ("4 hours", 240), ("8 hours", 480)] {
            let m = NSMenuItem(title: title, action: #selector(stayAwake(_:)), keyEquivalent: ""); m.tag = minutes; m.target = self; sub.addItem(m)
        }
        if (awake["stayUntil"] as? Double ?? 0) > 0 {
            sub.addItem(.separator())
            let m = NSMenuItem(title: "Cancel", action: #selector(stayAwake(_:)), keyEquivalent: ""); m.tag = 0; m.target = self; sub.addItem(m)
        }
        stay.submenu = sub; menu.addItem(stay)

        menu.addItem(.separator())
        let settings = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ","); settings.target = self; menu.addItem(settings)
        let login = NSMenuItem(title: "Open at login", action: #selector(toggleLogin), keyEquivalent: "")
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off; login.target = self
        menu.addItem(login)
        menu.addItem(NSMenuItem(title: "Quit Seer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private var config: [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(contentsOf: seerHome.appendingPathComponent("config.json")))) as? [String: Any] ?? [:]
    }

    // The login item matches config.json's launchAtLogin (default on); the Settings page writes it from the phone.
    private func syncLogin() {
        let want = config["launchAtLogin"] as? Bool ?? true, on = SMAppService.mainApp.status == .enabled
        guard want != on else { return }
        do { if want { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
        catch { logLine("launch at login: \(error.localizedDescription)") }
    }

    private func open(_ path: String) {
        let zone = config["zone"] as? String
        NSWorkspace.shared.open(URL(string: (zone != nil ? "https://seer.\(zone!)" : "http://127.0.0.1:7399") + path)!)
    }
    @objc private func openHome() { open("/") }
    @objc private func openSettings() { open("/settings") }

    @objc private func stayAwake(_ sender: NSMenuItem) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:7399/local/awake")!)
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["minutes": sender.tag])
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in DispatchQueue.main.async { self?.poll() } }.resume()
    }

    // The menu's switch saves the setting through Seer (so the phone shows it too), then the login item follows.
    @objc private func toggleLogin() {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:7399/local/settings")!)
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["launchAtLogin": SMAppService.mainApp.status != .enabled])
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in DispatchQueue.main.async { self?.syncLogin() } }.resume()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
