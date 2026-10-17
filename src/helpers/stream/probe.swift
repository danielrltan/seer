// SeerStream probe: can the Mac still be captured with the lid closed? Every 2 s, for `minutes`, it saves a
// screenshot of the main display to ~/.seer/probe/ and logs whether the display is awake and the screen locked.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

let out = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".seer/probe")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
let logURL = out.appendingPathComponent("probe.log")
func log(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
    if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
    else { try? line.write(to: logURL, atomically: true, encoding: .utf8) }
}

func sessionLocked() -> Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (d["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func save(_ image: CGImage, _ name: String) {
    let url = out.appendingPathComponent(name) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

// Mean brightness of a 32x32 thumbnail, so the log says "black" without opening the PNG.
func brightness(_ image: CGImage) -> Double {
    let w = 32, h = 32
    var px = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return -1 }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    var sum = 0
    for i in stride(from: 0, to: px.count, by: 4) { sum += Int(px[i]) + Int(px[i + 1]) + Int(px[i + 2]) }
    return Double(sum) / Double(w * h * 3) / 255
}

let minutes = Double(CommandLine.arguments.dropFirst().first(where: { Double($0) != nil }) ?? "5") ?? 5
log("probe start, \(minutes) min")
Task {
    let until = Date().addingTimeInterval(minutes * 60)
    var n = 0
    while Date() < until {
        let main = CGMainDisplayID()
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var state = "displays=\(count) mainAsleep=\(CGDisplayIsAsleep(main) != 0) locked=\(sessionLocked())"
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            if let display = content.displays.first {
                let config = SCStreamConfiguration()
                config.width = display.width; config.height = display.height
                let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
                n += 1
                let name = String(format: "%04d.png", n)
                save(image, name)
                state += " shot=\(name) \(image.width)x\(image.height) brightness=\(String(format: "%.2f", brightness(image)))"
            } else { state += " no displays to capture" }
        } catch { state += " capture error: \(error.localizedDescription)" }
        log(state)
        try? await Task.sleep(nanoseconds: 2_000_000_000)
    }
    log("probe end")
    exit(0)
}
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
