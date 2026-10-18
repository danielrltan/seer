// Seer.app's screen stream: the screen as live H.264, plus mouse and keyboard from the phone. It runs inside
// Seer.app, so Screen Recording and Accessibility belong to the app alone, never to node or a terminal.
//
// It listens on ~/.seer/stream.sock (mode 600) for one client, the Seer daemon:
//   in:  JSON lines  {"cmd":"start","maxWidth":1512,"fps":30,"bitrate":3000000} | {"cmd":"stop"} | {"cmd":"keyframe"}
//                    {"cmd":"input","t":"down|up|move|scroll|text|key", ...}   x,y in 0...1 of the main display
//                    {"cmd":"input","t":"nudge|press|release|click|scroll", ...} relative, at the cursor (Pad)
//   out: frames      [u8 type][u32 length][payload]
//        type 1 config: [u16 json length][json {codec,width,height}][avcC]
//        type 2 key / 3 delta: [u64 timestamp µs][H.264 access unit, AVCC]
//        type 4 status: json
// Capture runs only between start and stop (the daemon starts it when a viewer connects), so the menu bar's
// screen-recording indicator is not on all day.
import AppKit
import ApplicationServices
import CoreMedia
import Foundation
import ScreenCaptureKit
import VideoToolbox

let seerHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".seer")
let sockPath = seerHome.appendingPathComponent("stream.sock").path

func logLine(_ s: String) { FileHandle.standardError.write("\(ISO8601DateFormatter().string(from: Date())) \(s)\n".data(using: .utf8)!) }

// ---------- the one client ----------
final class Link {
    private var fd: Int32 = -1
    private let lock = NSLock()
    func attach(_ newFd: Int32) { lock.lock(); if fd >= 0 { close(fd) }; fd = newFd; lock.unlock() }
    func detach(_ oldFd: Int32) { lock.lock(); if fd == oldFd { close(fd); fd = -1 }; lock.unlock() }
    func send(_ type: UInt8, _ payload: Data) {
        var frame = Data([type])
        var len = UInt32(payload.count).bigEndian
        frame.append(Data(bytes: &len, count: 4))
        frame.append(payload)
        lock.lock(); defer { lock.unlock() }
        guard fd >= 0 else { return }
        frame.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
            var off = 0
            while off < frame.count {
                let n = write(fd, p.baseAddress! + off, frame.count - off)
                if n <= 0 { break }
                off += n
            }
        }
    }
    func status(_ obj: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: obj) { send(4, d) }
    }
}
let link = Link()

// ---------- encoder ----------
final class Encoder {
    private var session: VTCompressionSession?
    private var lastConfig = Data()
    private var forceKey = true
    let width: Int32, height: Int32

    init?(width: Int, height: Int, fps: Int, bitrate: Int) {
        self.width = Int32(width); self.height = Int32(height)
        // Low-latency rate control first (no frame reordering, steady bitrate); plain real-time if refused.
        for lowLatency in [true, false] {
            var s: VTCompressionSession?
            let spec: [CFString: Any] = lowLatency ? [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] : [:]
            let st = VTCompressionSessionCreate(allocator: nil, width: self.width, height: self.height, codecType: kCMVideoCodecType_H264,
                                                encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                outputCallback: nil, refcon: nil, compressionSessionOut: &s)
            guard st == noErr, let s else { continue }
            let props: [CFString: Any] = [
                kVTCompressionPropertyKey_RealTime: true,
                kVTCompressionPropertyKey_AllowFrameReordering: false,
                kVTCompressionPropertyKey_ProfileLevel: lowLatency ? kVTProfileLevel_H264_ConstrainedHigh_AutoLevel : kVTProfileLevel_H264_Main_AutoLevel,
                kVTCompressionPropertyKey_AverageBitRate: bitrate,
                kVTCompressionPropertyKey_ExpectedFrameRate: fps,
                kVTCompressionPropertyKey_MaxKeyFrameInterval: fps * 4,
                kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 4,
            ]
            for (k, v) in props { VTSessionSetProperty(s, key: k, value: v as CFTypeRef) }
            VTCompressionSessionPrepareToEncodeFrames(s)
            session = s
            logLine("encoder \(width)x\(height) \(fps) fps \(bitrate / 1000) kbps lowLatency=\(lowLatency)")
            break
        }
        if session == nil { return nil }
    }

    func requestKey() { forceKey = true; lastConfig = Data() }

    func encode(_ pb: CVPixelBuffer, _ pts: CMTime) {
        guard let session else { return }
        let props: CFDictionary? = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        forceKey = false
        VTCompressionSessionEncodeFrame(session, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
                                        frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sbuf in
            guard status == noErr, let sbuf, let self else { return }
            self.emit(sbuf)
        }
    }

    private func emit(_ sbuf: CMSampleBuffer) {
        var key = true
        if let atts = CMSampleBufferGetSampleAttachmentsArray(sbuf, createIfNecessary: false) as? [[CFString: Any]],
           let notSync = atts.first?[kCMSampleAttachmentKey_NotSync] as? Bool { key = !notSync }
        if key, let fmt = CMSampleBufferGetFormatDescription(sbuf), let cfg = avcConfig(fmt), cfg.avcc != lastConfig {
            lastConfig = cfg.avcc
            let json = try! JSONSerialization.data(withJSONObject: ["codec": cfg.codec, "width": Int(width), "height": Int(height)])
            var payload = Data()
            var jl = UInt16(json.count).bigEndian
            payload.append(Data(bytes: &jl, count: 2)); payload.append(json); payload.append(cfg.avcc)
            link.send(1, payload)
        }
        guard let block = CMSampleBufferGetDataBuffer(sbuf) else { return }
        let length = CMBlockBufferGetDataLength(block)
        var payload = Data(count: 8 + length)
        let pts = CMSampleBufferGetPresentationTimeStamp(sbuf)
        var micros = UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000).bigEndian
        payload.withUnsafeMutableBytes { (p: UnsafeMutableRawBufferPointer) in
            memcpy(p.baseAddress!, &micros, 8)
            _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: p.baseAddress! + 8)
        }
        link.send(key ? 2 : 3, payload)
    }

    // avcC from the SPS and PPS, and the codec string WebCodecs wants (avc1.PPCCLL from the SPS).
    private func avcConfig(_ fmt: CMFormatDescription) -> (avcc: Data, codec: String)? {
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                                 parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr, count >= 2 else { return nil }
        func set(_ i: Int) -> Data? {
            var ptr: UnsafePointer<UInt8>?; var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                     parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let ptr else { return nil }
            return Data(bytes: ptr, count: size)
        }
        guard let sps = set(0), let pps = set(1), sps.count >= 4 else { return nil }
        var d = Data([1, sps[1], sps[2], sps[3], 0xFF, 0xE1])
        d.append(contentsOf: [UInt8(sps.count >> 8), UInt8(sps.count & 0xFF)]); d.append(sps)
        d.append(1)
        d.append(contentsOf: [UInt8(pps.count >> 8), UInt8(pps.count & 0xFF)]); d.append(pps)
        return (d, String(format: "avc1.%02X%02X%02X", sps[1], sps[2], sps[3]))
    }
}

// ---------- capture ----------
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var encoder: Encoder?
    private var lastFrame: CVPixelBuffer?
    private let queue = DispatchQueue(label: "seer.capture")
    private(set) var running = false
    private var cursorTimer: DispatchSourceTimer?
    private var lastCursor = CGPoint(x: -1, y: -1)

    func start(maxWidth: Int, fps: Int, bitrate: Int) async {
        await stop()
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                link.status(["error": "no display to capture"]); return
            }
            let scale = min(1.0, Double(maxWidth) / Double(display.width))
            let w = Int(Double(display.width) * scale) & ~1, h = Int(Double(display.height) * scale) & ~1
            guard let enc = Encoder(width: w, height: h, fps: fps, bitrate: bitrate) else { link.status(["error": "H.264 encoder unavailable"]); return }
            let cfg = SCStreamConfiguration()
            cfg.width = w; cfg.height = h
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            cfg.queueDepth = 4
            cfg.showsCursor = true
            cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try await s.startCapture()
            queue.sync { encoder = enc; stream = s; running = true; watchCursor(display.displayID) }
            link.status(["capturing": true, "width": w, "height": h])
            logLine("capture started \(w)x\(h)")
        } catch {
            let tcc = error.localizedDescription.contains("TCC") || !CGPreflightScreenCaptureAccess()
            link.status(["error": tcc ? "screen-recording" : "capture failed: \(error.localizedDescription)"])
            logLine("capture failed: \(error)")
        }
    }

    func stop() async {
        let s: SCStream? = queue.sync { let s = stream; stream = nil; encoder = nil; lastFrame = nil; running = false; stopCursor(); return s }
        if let s { try? await s.stopCapture(); logLine("capture stopped") }
    }

    // A new viewer needs a keyframe now; a still screen sends no new frames, so the last one is encoded again.
    func keyframe() {
        queue.async {
            self.lastCursor = CGPoint(x: -1, y: -1)                             // the new viewer needs it too
            self.encoder?.requestKey()
            if let pb = self.lastFrame { self.encoder?.encode(pb, CMClockGetTime(CMClockGetHostTimeClock())) }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = atts.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pb = sb.imageBuffer else { return }
        lastFrame = pb
        encoder?.encode(pb, CMSampleBufferGetPresentationTimeStamp(sb))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logLine("stream stopped: \(error.localizedDescription)")
        link.status(["capturing": false, "error": error.localizedDescription])
        queue.async { self.stream = nil; self.encoder = nil; self.running = false; self.stopCursor() }
    }

    // Where the pointer is, as fractions of the captured display (the frames' space), so a zoomed-in viewer can
    // follow it. Whatever moved it (the phone, a real mouse, an app), sampled 30 times a second while capturing and
    // sent only when it moved; nothing while it is on another display.
    private func watchCursor(_ id: CGDirectDisplayID) {
        stopCursor()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0 / 30, leeway: .milliseconds(5))
        t.setEventHandler { [weak self] in
            guard let self, let p = CGEvent(source: nil)?.location, p != self.lastCursor else { return }
            let b = CGDisplayBounds(id)
            guard b.contains(p) else { return }
            self.lastCursor = p
            let f = { (v: CGFloat) in (Double(v) * 100_000).rounded() / 100_000 }
            link.status(["cursor": ["x": f((p.x - b.minX) / b.width), "y": f((p.y - b.minY) / b.height)]])
        }
        t.resume(); cursorTimer = t
    }
    private func stopCursor() { cursorTimer?.cancel(); cursorTimer = nil; lastCursor = CGPoint(x: -1, y: -1) }
}
let capture = Capture()

// ---------- what has focus ----------
// After a click or Tab, is a text field focused on the Mac? The viewer uses it to bring up the phone's keyboard.
// A text control by role, or anything whose value can be set and that has a text selection (web text fields).
enum Focus {
    static let queue = DispatchQueue(label: "seer.focus")
    static var last: Bool?
    static func isText() -> Bool {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.3)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let ref = focused, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return false }
        let el = ref as! AXUIElement
        AXUIElementSetMessagingTimeout(el, 0.3)
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleRef)
        let role = (roleRef as? String) ?? ""
        if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"].contains(role) { return true }
        var settable = DarwinBoolean(false)
        var range: CFTypeRef?
        return AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
            && AXUIElementCopyAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, &range) == .success
    }
    // Checked twice (apps take a moment to move focus); reported every time after a click, so the viewer can act.
    static func checkSoon() {
        for delay in [0.15, 0.5] {
            queue.asyncAfter(deadline: .now() + delay) {
                let text = isText()
                if delay == 0.15 || text != last { link.status(["textFocus": text]) }
                last = text
            }
        }
    }
}

// ---------- input ----------
enum Input {
    static var lastClick = (time: Date.distantPast, x: 0.0, y: 0.0, count: 0)
    static var buttonDown = false

    static func point(_ j: [String: Any]) -> CGPoint {
        let b = CGDisplayBounds(CGMainDisplayID())
        let x = min(max((j["x"] as? Double) ?? 0, 0), 1), y = min(max((j["y"] as? Double) ?? 0, 0), 1)
        return CGPoint(x: b.minX + x * b.width, y: b.minY + y * b.height)
    }
    static func flags(_ j: [String: Any]) -> CGEventFlags {
        var f = CGEventFlags()
        for m in (j["mods"] as? [String]) ?? [] {
            switch m { case "cmd": f.insert(.maskCommand); case "shift": f.insert(.maskShift)
            case "alt": f.insert(.maskAlternate); case "ctrl": f.insert(.maskControl); default: break }
        }
        return f
    }
    static let keys: [String: CGKeyCode] = [
        "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117, "Home": 115, "End": 119,
        "PageUp": 116, "PageDown": 121, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
        "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
        "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
        "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    ]

    static func handle(_ j: [String: Any]) {
        let src = CGEventSource(stateID: .hidSystemState)
        switch j["t"] as? String {
        case "move":
            CGEvent(mouseEventSource: src, mouseType: buttonDown ? .leftMouseDragged : .mouseMoved, mouseCursorPosition: point(j), mouseButton: .left)?.post(tap: .cghidEventTap)
        case "down", "up":
            let p = point(j), right = (j["button"] as? String) == "right", down = j["t"] as? String == "down"
            if down && !right {
                let now = Date(), near = abs(p.x - lastClick.x) < 6 && abs(p.y - lastClick.y) < 6
                lastClick = (now, p.x, p.y, now.timeIntervalSince(lastClick.time) < 0.4 && near ? lastClick.count + 1 : 1)
            }
            let type: CGEventType = right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
            if !right { buttonDown = down }
            let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: right ? .right : .left)
            e?.setIntegerValueField(.mouseEventClickState, value: Int64(right ? 1 : lastClick.count))
            e?.flags = flags(j)
            e?.post(tap: .cghidEventTap)
            if !down && !right { Focus.checkSoon() }
        case "scroll", "nudge", "press", "release", "click":
            Pad.queue.async { Pad.handle(j) }                                  // relative: the trackpad's own queue
        case "text":
            for ch in ((j["text"] as? String) ?? "") {
                let utf16 = Array(String(ch).utf16)
                for down in [true, false] {
                    let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
                    e?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                    e?.post(tap: .cghidEventTap)
                }
            }
        case "key":
            guard let name = j["key"] as? String, let code = keys[name] ?? keys[name.lowercased()] else { return }
            // A real arrow key also carries the fn and keypad flags, and macOS's own shortcuts match on them:
            // ctrl+arrow without them switches no Space and opens no Mission Control.
            var f = flags(j)
            if (123...126).contains(code) { f.insert(.maskSecondaryFn); f.insert(.maskNumericPad) }
            else if [115, 116, 117, 119, 121].contains(code) { f.insert(.maskSecondaryFn) }
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
                e?.flags = f
                e?.post(tap: .cghidEventTap)
            }
            if ["Tab", "Enter", "Escape"].contains(name) { Focus.checkSoon() }
        default: break
        }
    }
}

// ---------- the phone as a trackpad ----------
// Relative input: the pointer moves by points, buttons press and click where it is, and two-finger scroll carries
// a trackpad's phases and momentum. The phone's touches reach the Mac in uneven bursts (its touch rate, then the
// network bunching them), so nothing is posted as it arrives: moves and scrolls fill reservoirs (Lag) that a
// 120 Hz pump drains a little behind the finger, and a flick's momentum runs here at that rate too. Jitter between
// phone and Mac never reaches the screen. All of it lives on one queue; the pump stops when idle.
//
// Two reservoirs in a row, as one alone pulses where 60 Hz touches meet the 120 Hz pump. Measured with a steady
// finger: one stage draining a third per 8 ms (17 ms behind) varies ±24% from event to event, ±42% when the network
// holds back every third touch; two stages draining half (the same 17 ms) ±11% and ±34%; two draining a third
// (33 ms) ±4% and ±16%. Scroll takes the smoothest; the pointer, where lag is felt more, the quicker.
struct Lag {
    var a = (x: 0.0, y: 0.0), b = (x: 0.0, y: 0.0)
    var x: Double { a.x + b.x }
    var y: Double { a.y + b.y }
    var isEmpty: Bool { a == (0, 0) && b == (0, 0) }
    mutating func add(_ dx: Double, _ dy: Double) { a.x += dx; a.y += dy }
    // What goes out this tick (k: the share each stage passes on); all of it once both axes are under `tiny`.
    mutating func step(_ k: Double, tiny: Double) -> (x: Double, y: Double) {
        if abs(x) < tiny && abs(y) < tiny { return empty() }
        let m = (x: a.x * k, y: a.y * k)
        a.x -= m.x; a.y -= m.y; b.x += m.x; b.y += m.y
        let o = (x: b.x * k, y: b.y * k)
        b.x -= o.x; b.y -= o.y
        return o
    }
    mutating func empty() -> (x: Double, y: Double) { defer { self = Lag() }; return (x, y) }
}

enum Pad {
    static let queue = DispatchQueue(label: "seer.pad", qos: .userInteractive)
    static let src = CGEventSource(stateID: .hidSystemState)
    static var post: (CGEvent) -> Void = { $0.post(tap: .cghidEventTap) }       // replaceable, to test without posting
    static let period = 1.0 / 120
    static var timer: DispatchSourceTimer?
    static var lastTick = 0.0

    // pointer
    static var moves = Lag()                          // points still to move
    static var cursor = CGPoint.zero                  // where the pump put the pointer, fractions kept
    static var movedAt = 0.0                          // when it last did
    static var deltaRem = (x: 0.0, y: 0.0)            // fractions owed to the integer delta fields
    static var held: CGMouseButton?                   // a press not yet released: moves are drags

    // scroll
    static var scrolls = Lag()                        // points still to scroll
    static var rem = (x: 0.0, y: 0.0)                 // fractions of a pixel not yet posted
    static var touching = false, began = false, ending = false
    static var flick = (x: 0.0, y: 0.0)               // release velocity, points per ms
    static var gliding = false, glideBegan = false
    static var velocity = (x: 0.0, y: 0.0), owed = (x: 0.0, y: 0.0)
    static var watchdog: DispatchSourceTimer?         // ends a gesture whose end never came
    static let flickMin = 0.1, glideMin = 0.02        // points per ms
    static let scrollShare = 1.0 / 3, pointerShare = 0.5   // what each stage passes on per 8 ms

    static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
    static var busy: Bool { !moves.isEmpty || !scrolls.isEmpty || ending || gliding }

    static func handle(_ j: [String: Any]) {
        let num = { (k: String) in (j[k] as? Double).flatMap { $0.isFinite ? $0 : nil } ?? 0 }
        let right = j["button"] as? String == "right"
        switch j["t"] as? String {
        case "nudge":
            stopGlide(keep: false)
            if moves.isEmpty { sync() }
            moves.add(num("dx"), num("dy"))
        case "press", "release":
            stopGlide(keep: false); flushMove(); sync()
            let down = j["t"] as? String == "press"
            button(right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp), right, 1, j)
            if down { held = right ? .right : .left } else if held == (right ? .right : .left) { held = nil }
            if !down && !right { Focus.checkSoon() }
        case "click":
            stopGlide(keep: false); flushMove(); sync()
            // One click per message: the phone sent the earlier taps, so a double click is down(2) up(2) here.
            let count = min(max((j["count"] as? Int) ?? 1, 1), 3)
            button(right ? .rightMouseDown : .leftMouseDown, right, count, j)
            button(right ? .rightMouseUp : .leftMouseUp, right, count, j)
            if !right { Focus.checkSoon() }
        case "scroll":
            switch j["phase"] as? String {
            case "begin":
                stopGlide(keep: true)
                if touching && began { scroll(0, 0, phase: 4, momentum: 0, always: true) }   // the last one never ended
                touching = true; began = false; ending = false
            case "move":
                if !touching || ending {                                         // its begin was lost
                    if touching && began { scroll(0, 0, phase: 4, momentum: 0, always: true) }
                    touching = true; began = false; ending = false
                }
            case "end":
                if touching {
                    ending = true
                    let vx = num("vx"), vy = num("vy")
                    flick = hypot(vx, vy) > flickMin ? (vx, vy) : (0, 0)
                }
            default: break                                                      // phase-less: direct-touch scroll
            }
            scrolls.add(num("dx"), num("dy"))
            if touching && !ending { watch() } else { watchdog?.cancel(); watchdog = nil }
        default: return
        }
        kick()
    }

    // ---------- the pump ----------
    static func kick() {
        guard busy, timer == nil else { return }
        lastTick = now() - period; tick()                                       // the first step goes out now
        guard busy else { return }
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        t.schedule(deadline: .now() + period, repeating: period, leeway: .microseconds(500))
        t.setEventHandler { tick() }
        t.resume(); timer = t
    }

    static func tick() {
        let t = now(), dt = min(max((t - lastTick) * 1000, 1), 34)            // ms; a stalled timer is not a leap
        lastTick = t
        let share = { (per8: Double) in 1 - pow(1 - per8, dt / 8) }             // per 8 ms, whatever the tick
        let take = share(scrollShare)
        if !moves.isEmpty { let s = moves.step(share(pointerShare), tiny: 0.5); move(s.x, s.y) }
        if touching && ending && flick != (0, 0) && began {
            // A flick: the gesture ends now and the glide starts at the release speed, paying out what the
            // reservoir still owes at that speed, so there is no dip while it drains and no lurch after.
            scroll(0, 0, phase: 4, momentum: 0, always: true)
            touching = false; began = false; ending = false
            gliding = true; glideBegan = false
            velocity = flick; owed = scrolls.empty()
        }
        if !scrolls.isEmpty {
            let s = scrolls.step(take, tiny: 1)
            if touching { scroll(s.x, s.y, phase: began ? 2 : 1, momentum: 0, always: !began); began = true }
            else { scroll(s.x, s.y, phase: 0, momentum: 0, always: false) }
        }
        if touching && ending && scrolls.isEmpty && (flick == (0, 0) || !began) {
            if began { scroll(0, 0, phase: 4, momentum: 0, always: true) }
            touching = false; began = false; ending = false; rem = (0, 0)
        }
        if gliding { glide(dt, take) }
        if !busy { timer?.cancel(); timer = nil }
    }

    // Momentum, decaying as an iPhone's scroll view does (normal deceleration: v × 0.998 per ms).
    static func glide(_ dt: Double, _ take: Double) {
        func axis(_ v: inout Double, _ owed: inout Double) -> Double {
            let s = v * dt
            v *= pow(0.998, dt)
            guard owed != 0 else { return s }
            let pay = abs(owed) < 1 ? owed : owed * take
            if (owed > 0) == (s > 0) || s == 0 {                                // paid at the glide's speed or faster
                let want = abs(pay) > abs(s) ? pay : s
                if abs(owed) <= abs(want) { let out = abs(owed) > abs(s) ? owed : s; owed = 0; return out }
                owed -= want; return want
            }
            owed -= pay; return s + pay
        }
        let sx = axis(&velocity.x, &owed.x), sy = axis(&velocity.y, &owed.y)
        if hypot(velocity.x, velocity.y) < glideMin && owed == (0, 0) { stopGlide(keep: false); return }
        scroll(sx, sy, phase: 0, momentum: glideBegan ? 2 : 1, always: !glideBegan)
        glideBegan = true
    }

    // A touch, a click or a new scroll stops the glide at once, as a finger on a trackpad does. A new scroll keeps
    // what the old one still owed (it is finger travel); anything else drops it.
    static func stopGlide(keep: Bool) {
        guard gliding else { return }
        if glideBegan { scroll(0, 0, phase: 0, momentum: 3, always: true) }
        if keep { scrolls.add(owed.x, owed.y) }
        gliding = false; glideBegan = false; velocity = (0, 0); owed = (0, 0); rem = (0, 0)
    }

    // A gesture whose end never came (the phone slept, the network dropped it) ends after a second without word.
    // One timer, pushed back by each scroll message; a finger resting on the phone sends nothing, so not shorter.
    static func watch() {
        if watchdog == nil {
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.setEventHandler {
                watchdog?.cancel(); watchdog = nil
                if touching && !ending { ending = true; flick = (0, 0); kick() }
            }
            t.resume(); watchdog = t
        }
        watchdog?.schedule(deadline: .now() + 1, leeway: .milliseconds(50))
    }

    // Everything let go: the viewer left or the stream stopped. A held button left down would stay down.
    static func reset() {
        moves = Lag()
        if let b = held { button(b == .right ? .rightMouseUp : .leftMouseUp, b == .right, 1, [:]); held = nil }
        if touching && began { scroll(0, 0, phase: 4, momentum: 0, always: true) }
        touching = false; began = false; ending = false; scrolls = Lag(); rem = (0, 0)
        stopGlide(keep: false)
        timer?.cancel(); timer = nil; watchdog?.cancel(); watchdog = nil
    }

    // ---------- posting ----------
    // Continuous, as a trackpad's: apps move by exactly these pixels (precise deltas) instead of animating each event
    // as a wheel notch. The point deltas apps read are whole pixels (CoreGraphics truncates any fraction), so the
    // fractions are carried to the next event rather than lost: slow scrolls still move, and nothing drifts.
    static func scroll(_ fx: Double, _ fy: Double, phase: Int64, momentum: Int64, always: Bool) {
        rem.x += fx; rem.y += fy
        let px = rem.x.rounded(), py = rem.y.rounded()
        if px == 0 && py == 0 && !always { return }
        rem.x -= px; rem.y -= py
        guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: Int32(py), wheel2: Int32(px), wheel3: 0) else { return }
        e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)          // began 1, changed 2, ended 4
        e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)     // begin 1, continue 2, end 3
        post(e)
    }

    static func move(_ dx: Double, _ dy: Double) {
        let p = clamp(CGPoint(x: cursor.x + dx, y: cursor.y + dy), from: cursor)
        if p == cursor { return }
        deltaRem.x += p.x - cursor.x; deltaRem.y += p.y - cursor.y
        let ix = deltaRem.x.rounded(), iy = deltaRem.y.rounded()
        deltaRem.x -= ix; deltaRem.y -= iy
        cursor = p; movedAt = now()
        let type: CGEventType = held == .left ? .leftMouseDragged : held == .right ? .rightMouseDragged : .mouseMoved
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: held ?? .left) else { return }
        e.setIntegerValueField(.mouseEventDeltaX, value: Int64(ix))                // for apps that read motion, not position
        e.setIntegerValueField(.mouseEventDeltaY, value: Int64(iy))
        post(e)
    }

    static func flushMove() {
        if !moves.isEmpty { let s = moves.empty(); move(s.x, s.y) }
    }

    // Where the pointer really is, unless the pump moved it just now (the system lags a frame behind what was posted,
    // and reading it mid-glide would pull the pointer back). A real mouse or an absolute tap may have moved it since.
    static func sync() {
        guard now() - movedAt > 0.1, let real = CGEvent(source: nil)?.location else { return }
        if hypot(real.x - cursor.x, real.y - cursor.y) >= 1 { cursor = real }
    }

    // Kept on the display the pointer is on, edges as walls: the stream shows one display, and a pointer let through
    // to another would vanish from the phone. (Moved there some other way, it stays on that one.)
    static func clamp(_ p: CGPoint, from: CGPoint) -> CGPoint {
        var id: CGDirectDisplayID = 0, n: UInt32 = 0
        let b = CGGetDisplaysWithPoint(from, 1, &id, &n) == .success && n > 0 ? CGDisplayBounds(id) : CGDisplayBounds(CGMainDisplayID())
        return CGPoint(x: min(max(p.x, b.minX), b.maxX - 1), y: min(max(p.y, b.minY), b.maxY - 1))
    }

    static func button(_ type: CGEventType, _ right: Bool, _ count: Int, _ j: [String: Any]) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: cursor, mouseButton: right ? .right : .left) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        e.flags = Input.flags(j)
        post(e)
    }
}

// ---------- socket server ----------
func serve() {
    unlink(sockPath)
    let server = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { p in
        let bytes = Array(sockPath.utf8.prefix(p.count - 1))
        p.copyBytes(from: bytes + [0])
    }
    let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard ok == 0 else { logLine("bind \(sockPath) failed: \(errno)"); exit(1) }
    chmod(sockPath, 0o600)
    listen(server, 4)
    logLine("listening on \(sockPath)")

    Thread.detachNewThread {
        while true {
            let client = accept(server, nil, nil)
            guard client >= 0 else { continue }
            link.attach(client)
            logLine("client connected")
            Thread.detachNewThread { readLoop(client) }
        }
    }
}

func readLoop(_ fd: Int32) {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { break }
        buffer.append(contentsOf: chunk[0..<n])
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let j = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
            dispatch(j)
        }
    }
    link.detach(fd)
    logLine("client gone")
    Pad.queue.async { Pad.reset() }
    Task { await capture.stop() }
}

func dispatch(_ j: [String: Any]) {
    switch j["cmd"] as? String {
    case "start":
        let maxWidth = (j["maxWidth"] as? Int) ?? 1512, fps = (j["fps"] as? Int) ?? 30, bitrate = (j["bitrate"] as? Int) ?? 3_000_000
        Task { await capture.start(maxWidth: maxWidth, fps: fps, bitrate: bitrate) }
    case "stop": Pad.queue.async { Pad.reset() }; Task { await capture.stop() }
    case "keyframe": capture.keyframe()
    case "input":
        if !AXIsProcessTrusted() { link.status(["error": "accessibility"]); return }   // the service words it
        DispatchQueue.main.async { Input.handle(j) }
    case "ping": link.status(["pong": true, "accessibility": AXIsProcessTrusted(), "capturing": capture.running])
    default: break
    }
}

// Ask for Accessibility once at launch (Screen Recording is asked for by the first capture).
