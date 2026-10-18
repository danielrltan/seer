// Seer.app's screen stream: the screen as live H.264, plus mouse and keyboard from the phone. It runs inside
// Seer.app, so Screen Recording and Accessibility belong to the app alone, never to node or a terminal.
//
// It listens on ~/.seer/stream.sock (mode 600) for one client, the Seer daemon:
//   in:  JSON lines  {"cmd":"start","maxWidth":1512,"fps":30,"bitrate":3000000} | {"cmd":"stop"} | {"cmd":"keyframe"}
//                    {"cmd":"input","t":"down|up|move|drag|scroll|text|key", ...}
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
            queue.sync { encoder = enc; stream = s; running = true }
            link.status(["capturing": true, "width": w, "height": h])
            logLine("capture started \(w)x\(h)")
        } catch {
            let tcc = error.localizedDescription.contains("TCC") || !CGPreflightScreenCaptureAccess()
            link.status(["error": tcc ? "screen-recording" : "capture failed: \(error.localizedDescription)"])
            logLine("capture failed: \(error)")
        }
    }

    func stop() async {
        let s: SCStream? = queue.sync { let s = stream; stream = nil; encoder = nil; lastFrame = nil; running = false; return s }
        if let s { try? await s.stopCapture(); logLine("capture stopped") }
    }

    // A new viewer needs a keyframe now; a still screen sends no new frames, so the last one is encoded again.
    func keyframe() {
        queue.async {
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
        queue.async { self.stream = nil; self.encoder = nil; self.running = false }
    }
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
        case "scroll":
            let dx = Int32((j["dx"] as? Double) ?? 0), dy = Int32((j["dy"] as? Double) ?? 0)
            CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
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
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
                e?.flags = flags(j)
                e?.post(tap: .cghidEventTap)
            }
            if ["Tab", "Enter", "Escape"].contains(name) { Focus.checkSoon() }
        default: break
        }
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
    Task { await capture.stop() }
}

func dispatch(_ j: [String: Any]) {
    switch j["cmd"] as? String {
    case "start":
        let maxWidth = (j["maxWidth"] as? Int) ?? 1512, fps = (j["fps"] as? Int) ?? 30, bitrate = (j["bitrate"] as? Int) ?? 3_000_000
        Task { await capture.start(maxWidth: maxWidth, fps: fps, bitrate: bitrate) }
    case "stop": Task { await capture.stop() }
    case "keyframe": capture.keyframe()
    case "input":
        if !AXIsProcessTrusted() { link.status(["error": "accessibility"]); return }   // the service words it
        DispatchQueue.main.async { Input.handle(j) }
    case "ping": link.status(["pong": true, "accessibility": AXIsProcessTrusted(), "capturing": capture.running])
    default: break
    }
}

// Ask for Accessibility once at launch (Screen Recording is asked for by the first capture).
