// Seer.app runs the rest of Seer as its children, and restarts them if they stop:
//   seer daemon   the bundled Node runtime running Seer's service (home page, links, awake policy, headless, ...)
//   tunnel        the bundled cloudflared, connecting the Mac to Seer's links
// Each logs to ~/.seer/logs/<name>.log. A child that keeps dying waits longer each time (2, 4, ... 30 s).
import Foundation

final class Child {
    let name: String
    private let exe: String, args: [String], env: [String: String]
    private var proc: Process?
    private var stopping = false
    private var failures = 0
    private var startedAt = Date()

    init(name: String, exe: String, args: [String], env: [String: String]) {
        self.name = name; self.exe = exe; self.args = args; self.env = env
    }

    var running: Bool { proc?.isRunning ?? false }

    func start() {
        stopping = false
        let log = seerHome.appendingPathComponent("logs/\(name).log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        let out = try? FileHandle(forWritingTo: log)
        out?.seekToEndOfFile()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = env
        p.standardOutput = out; p.standardError = out
        p.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.exited() } }
        do { try p.run(); proc = p; startedAt = Date(); logLine("\(name) started (pid \(p.processIdentifier))") }
        catch { logLine("\(name) failed to start: \(error.localizedDescription)"); exited() }
    }

    private func exited() {
        guard !stopping else { return }
        failures = Date().timeIntervalSince(startedAt) > 60 ? 1 : failures + 1    // ran a minute: start the count again
        let wait = min(30.0, pow(2.0, Double(failures)))
        logLine("\(name) stopped; restarting in \(Int(wait)) s")
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self, !self.stopping, !self.running else { return }
            self.start()
        }
    }

    // SIGTERM, then up to 5 s for it to finish (the daemon thaws frozen apps and lets the Mac sleep again).
    func stop() {
        stopping = true
        guard let p = proc, p.isRunning else { return }
        p.terminate()
        let until = Date().addingTimeInterval(5)
        while p.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.05) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }
}

enum Bundled {
    static let resources = Bundle.main.resourceURL!.path
    static let node = resources + "/bin/node"
    static let cloudflared = resources + "/bin/cloudflared"
    // Seer's own code runs from ~/.seer/code (scripts/deploy-code.sh puts it there), outside the signed bundle, so
    // changing it leaves the app, and the Screen Recording and Accessibility it was given, as they are. A Mac that
    // has never had it deployed runs the copy inside the app.
    static var seerJs: String {
        let deployed = seerHome.appendingPathComponent("code/bin/seer.js").path
        return FileManager.default.fileExists(atPath: deployed) ? deployed : resources + "/seer/bin/seer.js"
    }
    static let me = Bundle.main.executablePath!

    // What the children see: Seer's home, the app (for its Wi-Fi subcommand), and the bundled tools first on PATH.
    static var env: [String: String] {
        var e = ProcessInfo.processInfo.environment
        e["SEER_HOME"] = seerHome.path
        e["SEER_APP"] = me
        e["PATH"] = resources + "/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        e.removeValue(forKey: "ANTHROPIC_API_KEY")
        return e
    }
}
