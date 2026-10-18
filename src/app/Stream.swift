// Seer.app's screen stream: the screen as live H.264, plus mouse and keyboard from the phone. It runs inside
// Seer.app, so Screen Recording and Accessibility belong to the app alone, never to node or a terminal.
//
// It listens on ~/.seer/stream.sock (mode 600) for one client, the Seer daemon:
//   in:  JSON lines  {"cmd":"start","maxWidth":1512,"fps":30,"bitrate":3000000[,"virtual":true]} | {"cmd":"stop"} | {"cmd":"keyframe"}
//                    {"cmd":"input","t":"down|up|move|scroll|text|key", ...}   x,y in 0...1 of the main display
//                    {"cmd":"input","t":"nudge|press|release|click|scroll", ...} relative, at the cursor (Pad)
//                    nudge's "magnet": false turns off its target assistance (the trackpadMagnet setting)
//   out: frames      [u8 type][u32 length][payload]
//        type 1 config: [u16 json length][json {codec,width,height}][avcC]
//        type 2 key / 3 delta: [u64 timestamp µs][H.264 access unit, AVCC]
//        type 4 status: json ({"capturing":true,"virtual":bool,...}, {"error":...}, {"screen":"virtual screen: ..."}, ...)
// Capture runs only between start and stop (the daemon starts it when a viewer connects), so the menu bar's
// screen-recording indicator is not on all day.
import AppKit
import ApplicationServices
import CoreMedia
import Foundation
import IOKit
import ScreenCaptureKit
import VideoToolbox

let seerHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".seer")
let sockPath = seerHome.appendingPathComponent("stream.sock").path

// Also to ~/.seer/logs/app.log: opened by LaunchServices or the login item, the app's stderr is /dev/null, and
// everything the stream helper said was lost. Started afresh past 1 MB.
let appLogFd: Int32 = {
    let p = seerHome.appendingPathComponent("logs/app.log").path
    try? FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let big = ((try? FileManager.default.attributesOfItem(atPath: p))?[.size] as? Int ?? 0) > 1_000_000
    return open(p, O_WRONLY | O_APPEND | O_CREAT | (big ? O_TRUNC : 0), 0o644)
}()
func logLine(_ s: String) {
    let d = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n".data(using: .utf8)!
    FileHandle.standardError.write(d)
    if appLogFd >= 0 { d.withUnsafeBytes { _ = write(appLogFd, $0.baseAddress!, d.count) } }
}

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

// ---------- a screen for a closed lid ----------
// With the lid closed and no monitor attached, macOS has no active display and there is nothing to capture. Seer
// then adds a virtual one the size of the built-in screen (CoreGraphics' private CGVirtualDisplay, as DeskPad and
// BetterDisplay do): the Mac lays its windows out on it and the stream shows it. It lives only in this process,
// so it goes when Seer does, and as soon as a real display is back (the lid opened, a monitor plugged in): a 2 s
// watcher runs while it exists, streamed or not. If a later macOS drops the classes, capture says there is no screen.
//
// While the lid stays closed it is kept between streams, not released. WindowServer keys a display by
// vendor/product/serial and refuses a second with the same three ("already exists"), and a virtual display released
// while the Mac is not fully awake is not removed at once: "Deferred hotplugs cannot be processed in a non-wake
// state", and it lingers, uncapturable, until the Mac next wakes properly (seen: released 13:44, gone 16:48; every
// create in between failed). Released early it only goes later and takes its serial with it; kept, the next stream
// reuses it (and the windows stay where they were). With a real display active when a stream stops (forced, lid
// open) it goes 20 s later. A refused serial is still skipped for the next of a few (few: macOS remembers each
// serial's arrangement as a display of its own).
//
// Everything here runs on the main queue. Each step is logged and sent as {"screen": "..."} (the daemon logs it).
// SEER_VIRTUAL_SCREEN=1, or "virtual": true on start (config.json stream.virtualScreen), streams the virtual screen
// even with a real display active, for testing with the lid open; it then never hands back.
enum VirtualScreen {
    static let vendor: UInt32 = 0x5EE2
    static let serials: [UInt32] = [1, 2, 3, 4]
    private static var display: CGVirtualDisplay?
    private static var removal: DispatchWorkItem?
    private static var serial: UInt32 = 1                               // the last that worked: tried first
    static let envForced = ProcessInfo.processInfo.environment["SEER_VIRTUAL_SCREEN"] == "1"
    static var forced = envForced
    static var inUse = false                                           // a capture is streaming it: no timed removal
    private static var keptNoted = false                               // "kept" said once per screen
    static var id: CGDirectDisplayID? { display?.displayID }

    static func note(_ s: String) { logLine("virtual screen: \(s)"); link.status(["screen": "virtual screen: \(s)"]) }

    static func activeDisplays() -> [CGDirectDisplayID] { displayList(CGGetActiveDisplayList) }
    static func onlineDisplays() -> [CGDirectDisplayID] { displayList(CGGetOnlineDisplayList) }
    private static func displayList(_ get: (UInt32, UnsafeMutablePointer<CGDirectDisplayID>?, UnsafeMutablePointer<UInt32>?) -> CGError) -> [CGDirectDisplayID] {
        var n: UInt32 = 0; _ = get(0, nil, &n)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(n)); _ = get(n, &ids, &n)
        return Array(ids.prefix(Int(n)))
    }
    // Seer's by its vendor, not by the one id held here: a lingering earlier one is Seer's too, never "real".
    static func isOurs(_ id: CGDirectDisplayID) -> Bool { CGDisplayVendorNumber(id) == vendor }
    static var realDisplayActive: Bool { activeDisplays().contains { !isOurs($0) } }
    // A real display connected but not active: asleep with the lid open (or closed: lidClosed tells them apart).
    static var realDisplayOnline: Bool { onlineDisplays().contains { !isOurs($0) } }
    // The lid, from the power manager (IOPMrootDomain's AppleClamshellState). false if it cannot be read.
    static var lidClosed: Bool {
        let pm = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard pm != 0 else { return false }
        defer { IOObjectRelease(pm) }
        return (IORegistryEntryCreateCFProperty(pm, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Bool) ?? false
    }

    // The virtual screen's id (new: just added), or nil if macOS would not add one (the reason is noted).
    static func ensure() -> (id: CGDirectDisplayID, new: Bool)? {
        removal?.cancel(); removal = nil
        if let v = display, v.displayID != 0 { note("reused (display \(v.displayID))"); return (v.displayID, false) }
        display = nil
        guard NSClassFromString("CGVirtualDisplay") != nil else { note("not added: this macOS has no CGVirtualDisplay"); return nil }
        let strays = onlineDisplays().filter(isOurs)
        if !strays.isEmpty { note("an earlier one is still there (display \(strays.map(String.init).joined(separator: ", ")), going when the Mac wakes)") }
        let main = CGDisplayBounds(CGMainDisplayID())
        let w = main.width >= 640 ? Int(main.width) : 1512, h = main.height >= 400 ? Int(main.height) : 982
        let s = CGVirtualDisplaySettings()
        s.hiDPI = 1
        s.modes = [CGVirtualDisplayMode(width: UInt(w), height: UInt(h), refreshRate: 60)]
        var refused: [UInt32] = []
        for n in [serial] + serials.filter({ $0 != serial }) {
            let d = CGVirtualDisplayDescriptor()
            d.setDispatchQueue(DispatchQueue.main)
            d.name = "Seer"
            d.maxPixelsWide = UInt32(w * 2); d.maxPixelsHigh = UInt32(h * 2)
            d.sizeInMillimeters = CGSize(width: Double(w) * 0.2, height: Double(h) * 0.2)
            d.vendorID = vendor; d.productID = vendor; d.serialNum = n
            // Only for the one held now: a late word about an earlier one must not drop its successor.
            d.terminationHandler = { _, gone in
                DispatchQueue.main.async { if display === gone { display = nil; inUse = false; watcher?.invalidate(); watcher = nil; note("ended by macOS") } }
            }
            guard let v = CGVirtualDisplay(descriptor: d), v.displayID != 0 else { refused.append(n); continue }   // that serial is still taken
            guard v.apply(s) else { note("not added: macOS refused its \(w)x\(h) mode (serial \(n))"); return nil }   // released here: removed
            display = v; serial = n; keptNoted = false
            watch()
            note("added \(w)x\(h) HiDPI (display \(v.displayID), serial \(n)\(refused.isEmpty ? "" : "; serial \(refused.map(String.init).joined(separator: ", ")) still taken"))")
            return (v.displayID, true)
        }
        note("not added: serials \(refused.map(String.init).joined(separator: ", ")) all still taken by earlier ones (they go when the Mac wakes)")
        return nil
    }

    // While it exists: once a real display is back, the stream moves to that one (not when forced: the real display
    // is there all along), and one kept between streams goes. One already timed to go (forced) is left to its timer.
    private static var watcher: Timer?
    static func watch() {
        guard watcher == nil, display != nil else { return }
        watcher = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { t in
            guard display != nil else { t.invalidate(); watcher = nil; return }
            guard realDisplayActive else { return }
            if inUse {
                if !forced { t.invalidate(); watcher = nil; note("a real display is back: handing over"); capture.restart() }
            } else if removal == nil { drop("a real display is back") }
        }
    }

    // A stream on it stopped (or never started). Lid closed, no real display: kept for the next stream, since
    // releasing it now would only leave it lingering (see above). A real display active: gone in 20 s, unless a
    // quick reconnect claims it (keeping the window layout).
    static func streamEnded(_ why: String) {
        inUse = false
        guard display != nil else { return }
        if realDisplayActive { remove(after: 20, why); return }
        removal?.cancel(); removal = nil
        if !keptNoted { keptNoted = true; note("kept for the next stream (lid closed)") }
        watch()
    }

    static func remove(after seconds: Double, _ why: String) {
        guard display != nil else { return }
        removal?.cancel()
        // Checked again when it is due: the lid closed in the meantime keeps it after all.
        let item = DispatchWorkItem { removal = nil; if inUse { return }; if realDisplayActive { drop(why) } else { streamEnded(why) } }
        removal = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }
    // Releasing it is what removes it (there is no remove call). true if there was one.
    @discardableResult static func drop(_ why: String) -> Bool {
        removal?.cancel(); removal = nil
        watcher?.invalidate(); watcher = nil
        inUse = false
        guard let v = display else { return false }
        display = nil; keptNoted = false
        note("removed (display \(v.displayID); \(why))")
        return true
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
    private var shape = "arrow", ticks = 0             // which cursor the Mac shows (see CursorShape)
    private var params: (Int, Int, Int, Bool)?

    // Start, stop and restart run one at a time, in the order asked. Run side by side (a viewer leaving as the next
    // arrives), a stop's 20 s removal could be set after the next start had claimed the virtual screen, and take it
    // away mid-stream.
    private let opLock = NSLock()
    private var lastOp: Task<Void, Never>?
    func enqueue(_ op: @escaping (Capture) async -> Void) {
        opLock.lock(); defer { opLock.unlock() }
        let prev = lastOp
        lastOp = Task { await prev?.value; await op(self) }
    }
    // Capture again as it was (the lid opened while streaming the virtual screen: the real one takes over).
    // (Nothing running by then: the watcher goes back on, and lets a kept screen go.)
    func restart() {
        enqueue { c in
            if let p = c.params, c.running { await c.start(maxWidth: p.0, fps: p.1, bitrate: p.2, virtual: p.3) }
            else { await MainActor.run { VirtualScreen.watch() } }
        }
    }

    // Shareable content; with a virtual screen just added, polled until macOS lists it (about half a second), up to 5 s.
    private func shareable(waitingFor v: CGDirectDisplayID?) async throws -> SCShareableContent {
        let until = Date().addingTimeInterval(5)
        while true {
            do {
                let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                if v == nil || c.displays.contains(where: { $0.displayID == v }) { return c }
                if Date() > until { await MainActor.run { VirtualScreen.note("display \(v!) not capturable after 5 s") }; return c }
            } catch {
                if v == nil || Date() > until || !CGPreflightScreenCaptureAccess() { throw error }
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    func start(maxWidth: Int, fps: Int, bitrate: Int, virtual: Bool = false) async {
        await stop()
        var virt: CGDirectDisplayID?                                       // the virtual screen this start stands on
        var started = false
        defer {                                                            // a failed start leaves no screen behind
            if !started && virt != nil { DispatchQueue.main.async { VirtualScreen.streamEnded("capture did not start") } }
        }
        do {
            let forced = await MainActor.run { VirtualScreen.forced = VirtualScreen.envForced || virtual; return VirtualScreen.forced }
            // A real display there but not active with the lid open is asleep (a dark wake): the daemon's caffeinate -u
            // is waking it, so give it 2 s rather than add a screen that would hand back as soon as it woke.
            if !forced && !VirtualScreen.realDisplayActive && !VirtualScreen.lidClosed && VirtualScreen.realDisplayOnline {
                let until = Date().addingTimeInterval(2)
                while !VirtualScreen.realDisplayActive && Date() < until { try? await Task.sleep(nanoseconds: 200_000_000) }
                logLine(VirtualScreen.realDisplayActive ? "display woke: streaming it" : "display still asleep after 2 s (lid open)")
            }
            // No real display (lid closed, no monitor, or still asleep), or forced: the virtual screen (also keeps one
            // about to go). A real display back: the virtual one goes, and macOS takes a moment to move the windows home.
            let plan: (id: CGDirectDisplayID?, dropped: Bool) = await MainActor.run {
                if forced || !VirtualScreen.realDisplayActive { return (VirtualScreen.ensure()?.id, false) }
                return (nil, VirtualScreen.drop("a real display is active"))
            }
            virt = plan.id
            if plan.dropped { try? await Task.sleep(nanoseconds: 800_000_000) }
            let content = try await shareable(waitingFor: virt)
            let ours = VirtualScreen.isOurs
            guard let display = virt.flatMap({ v in content.displays.first { $0.displayID == v } })
                    ?? content.displays.first(where: { $0.displayID == CGMainDisplayID() && !ours($0.displayID) })
                    ?? content.displays.first(where: { !ours($0.displayID) }) ?? content.displays.first else {
                link.status(["error": "no display to capture"]); return
            }
            let onVirtual = display.displayID == virt
            await MainActor.run {
                Input.screen = display.displayID                           // taps map onto the display streamed
                VirtualScreen.inUse = onVirtual
                if onVirtual { VirtualScreen.watch() }
            }
            // The pointer may be on no live display (the lid's screen is off, or forced): bring it to this one.
            if let p = CGEvent(source: nil)?.location, !CGDisplayBounds(display.displayID).contains(p) {
                let b = CGDisplayBounds(display.displayID); CGWarpMouseCursorPosition(CGPoint(x: b.midX, y: b.midY))
            }
            params = (maxWidth, fps, bitrate, virtual)
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
            started = true
            link.status(["capturing": true, "width": w, "height": h, "virtual": onVirtual])
            logLine("capture started \(w)x\(h) of display \(display.displayID)\(onVirtual ? " (virtual screen)" : "")")
        } catch {
            let tcc = error.localizedDescription.contains("TCC") || !CGPreflightScreenCaptureAccess()
            link.status(["error": tcc ? "screen-recording" : "capture failed: \(error.localizedDescription)"])
            logLine("capture failed: \(error)")
        }
    }

    func stop() async {
        let s: SCStream? = queue.sync { let s = stream; stream = nil; encoder = nil; lastFrame = nil; running = false; stopCursor(); return s }
        if let s { try? await s.stopCapture(); logLine("capture stopped") }
        await MainActor.run { VirtualScreen.streamEnded("the stream stopped 20 s before") }
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
        queue.async {
            guard self.stream === stream else { return }                   // one already stopped or replaced
            self.stream = nil; self.encoder = nil; self.running = false; self.stopCursor()
            link.status(["capturing": false, "error": error.localizedDescription])
            DispatchQueue.main.async { VirtualScreen.streamEnded("the stream ended 20 s before") }   // no stop may follow
        }
    }

    // Where the pointer is, as fractions of the captured display (the frames' space), so a zoomed-in viewer can
    // follow it, and which cursor shows (the viewer draws its own over it). Whatever moved it (the phone, a real
    // mouse, an app), sampled 30 times a second while capturing and sent only when it moved; the shape is read 10
    // times a second (on the main thread, as AppKit wants) and sent when it changes. Nothing while it is on
    // another display.
    private func watchCursor(_ id: CGDirectDisplayID) {
        stopCursor()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0 / 30, leeway: .milliseconds(5))
        t.setEventHandler { [weak self] in
            guard let self, let p = CGEvent(source: nil)?.location else { return }
            self.ticks += 1
            if self.ticks % 3 == 0 {
                DispatchQueue.main.async {
                    let k = CursorShape.read()
                    self.queue.async { if k != self.shape { self.shape = k; self.lastCursor = CGPoint(x: -1, y: -1) } }
                }
            }
            guard p != self.lastCursor else { return }
            let b = CGDisplayBounds(id)
            guard b.contains(p) else { return }
            self.lastCursor = p
            let f = { (v: CGFloat) in (Double(v) * 100_000).rounded() / 100_000 }
            link.status(["cursor": ["x": f((p.x - b.minX) / b.width), "y": f((p.y - b.minY) / b.height), "kind": self.shape]])
        }
        t.resume(); cursorTimer = t
    }
    private func stopCursor() { cursorTimer?.cancel(); cursorTimer = nil; lastCursor = CGPoint(x: -1, y: -1) }
}
let capture = Capture()

// ---------- which cursor ----------
// The Mac's cursor as the viewer draws it: "text" for the I-beam (over text that can be selected), else "arrow".
// Told apart by the image's size and hot spot, which is cheap: AppKit's own I-beam, or any cursor that is tall and
// narrow with its hot spot in the middle (the classic 9x18 I-beam the system reports). Each change is logged with
// its size, so a shape it gets wrong can be found in app.log.
enum CursorShape {
    static let ibeam = (NSCursor.iBeam.hotSpot, NSCursor.iBeam.image.size)
    static var last = ""
    static func read() -> String {
        guard let c = NSCursor.currentSystem else { return "arrow" }
        let h = c.hotSpot, s = c.image.size
        let centred = abs(h.x - s.width / 2) <= 2 && abs(h.y - s.height / 2) <= 2
        let k = (h == ibeam.0 && s == ibeam.1) || (centred && s.height >= 1.6 * s.width) ? "text" : "arrow"
        let sig = "\(k) \(Int(s.width))x\(Int(s.height)) at \(Int(h.x)),\(Int(h.y))"
        if sig != last { last = sig; logLine("cursor: \(sig)") }
        return k
    }
}

// ---------- what has focus ----------
// After a click or Tab, is a text field focused on the Mac, and did the click land on it? The viewer brings up
// the phone's keyboard only for a field the owner tapped: a field that took focus by itself (a new Chrome tab's
// address bar, a page's search box) gets the small Type button instead.
// A text control by role, or anything whose value can be set and that has a text selection (web text fields).
enum Focus {
    static let queue = DispatchQueue(label: "seer.focus")
    static var last: (text: Bool, tapped: Bool)?
    static func check(at p: CGPoint?) -> (text: Bool, tapped: Bool) {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.3)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let ref = focused, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return (false, false) }
        let el = ref as! AXUIElement
        AXUIElementSetMessagingTimeout(el, 0.3)
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleRef)
        let role = (roleRef as? String) ?? ""
        var text = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"].contains(role)
        if !text {
            var settable = DarwinBoolean(false)
            var range: CFTypeRef?
            text = AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
                && AXUIElementCopyAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, &range) == .success
        }
        guard text, let p else { return (text, false) }
        return (true, frame(el).insetBy(dx: -6, dy: -6).contains(p))
    }
    // The element's frame in global top-left points, the same space as a click; empty if it has none.
    static func frame(_ el: AXUIElement) -> CGRect {
        var posRef: CFTypeRef?, sizeRef: CFTypeRef?
        var pos = CGPoint.zero, size = CGSize.zero
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let pr = posRef, let sr = sizeRef, CFGetTypeID(pr) == AXValueGetTypeID(), CFGetTypeID(sr) == AXValueGetTypeID(),
              AXValueGetValue(pr as! AXValue, .cgPoint, &pos), AXValueGetValue(sr as! AXValue, .cgSize, &size) else { return .null }
        return CGRect(origin: pos, size: size)
    }
    // Checked twice (apps take a moment to move focus); reported every time after a click, so the viewer can act.
    // at: where the click landed (nil for a key: Tab or Enter moving focus is not a tap on a field).
    static func checkSoon(at p: CGPoint? = nil) {
        for delay in [0.15, 0.5] {
            queue.asyncAfter(deadline: .now() + delay) {
                let r = check(at: p)
                if delay == 0.15 || r.text != last?.text || r.tapped != last?.tapped { link.status(["textFocus": r.text, "tapped": r.tapped]) }
                last = r
            }
        }
    }
    static var cursor: CGPoint { CGEvent(source: nil)?.location ?? .zero }
}

// ---------- input ----------
enum Input {
    static var lastClick = (time: Date.distantPast, x: 0.0, y: 0.0, count: 0)
    static var buttonDown = false
    static var screen: CGDirectDisplayID = CGMainDisplayID()            // the display being streamed

    static func point(_ j: [String: Any]) -> CGPoint {
        let b = CGDisplayBounds(screen)
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
            if !down && !right { Focus.checkSoon(at: p) }
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

    // target assistance (Assist below finds what is under the pointer; all of this state lives on this queue)
    static var magnet = true                          // the trackpadMagnet setting, carried by every nudge
    static var vel = (x: 0.0, y: 0.0)                 // the finger's pointer velocity, points per ms, smoothed
    static var dir = (x: 0.0, y: 0.0)                 // which way it last went (unit), kept after it stops
    static var nudgedAt = 0.0
    static var target: Assist.Hit?                    // the last hit test's answer
    static var asking = false, askLater = false, askedAt = 0.0, epoch = 0
    static var drifting = false                       // the magnet is moving the pointer: the pump keeps running
    static var pulled = 0.0                           // points the magnet has moved it toward this target
    static var gain = 1.0, gainAt = 0.0               // the friction actually applied, eased (a step in speed reads as a stutter)
    // Friction: full below frictionFrom, fading out by frictionTo (points per ms, after the phone's acceleration:
    // a slow precise finger is 0.05-0.25, a 0.3 px/ms finger 0.8, a flick 2-4). The magnet acts once the finger is
    // still (stoppedFor), at most pullStep a tick (per 8 ms) and maxPull in all per target, and only within pullFor of the last nudge.
    static let frictionGain = 0.5, frictionFrom = 0.25, frictionTo = 0.8
    static let pullShare = 0.2, pullStep = 1.5, maxPull = 12.0, pullFor = 0.6, reach = 6.0
    static let gainEase = 70.0                        // ms: how fast the friction eases in and out
    static let stoppedFor = 0.08                      // the magnet waits until the finger has been still this long
    static let askEvery = 0.08, freshFor = 0.5        // at most 12 hit tests a second (each one costs the app under it); an answer older is ignored

    static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
    static var busy: Bool { !moves.isEmpty || !scrolls.isEmpty || ending || gliding || drifting }

    static func handle(_ j: [String: Any]) {
        let num = { (k: String) in (j[k] as? Double).flatMap { $0.isFinite ? $0 : nil } ?? 0 }
        let right = j["button"] as? String == "right"
        switch j["t"] as? String {
        case "nudge":
            stopGlide(keep: false)
            if moves.isEmpty { sync() }
            let dx = num("dx"), dy = num("dy")
            magnet = (j["magnet"] as? Bool) ?? true
            if !magnet { forget() }
            track(dx, dy)
            let g = friction()
            moves.add(dx * g, dy * g)
        case "press", "release":
            stopGlide(keep: false); flushMove(); sync(); forget()
            let down = j["t"] as? String == "press"
            button(right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp), right, 1, j)
            if down { held = right ? .right : .left } else if held == (right ? .right : .left) { held = nil }
            if !down && !right { Focus.checkSoon(at: Focus.cursor) }
        case "click":
            stopGlide(keep: false); flushMove(); sync(); forget()
            // One click per message: the phone sent the earlier taps, so a double click is down(2) up(2) here.
            let count = min(max((j["count"] as? Int) ?? 1, 1), 3)
            button(right ? .rightMouseDown : .leftMouseDown, right, count, j)
            button(right ? .rightMouseUp : .leftMouseUp, right, count, j)
            if !right { Focus.checkSoon(at: Focus.cursor) }
        case "scroll":
            forget()                                                            // the page moves: frames go stale
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

    // ---------- target assistance ----------
    // Aim assist for buttons: over something clickable, a slow finger moves the pointer at half speed (friction),
    // and once it slows or stops the pointer drifts the last few points into the target (magnet). A fast move
    // passes over targets untouched, and with nothing clickable near, every nudge moves exactly as before.
    // Assist hit-tests Accessibility on its own queue; here only its cached answer is read, so a slow app
    // (Chrome) delays the assist, never the pointer.
    static func track(_ dx: Double, _ dy: Double) {
        let t = now(), dt = min(max((t - nudgedAt) * 1000, 1), 100)
        let inst = (x: dx / dt, y: dy / dt)
        if t - nudgedAt > 0.1 { vel = inst }                                    // a new movement
        else { let w = 1 - exp(-dt / 30); vel.x += w * (inst.x - vel.x); vel.y += w * (inst.y - vel.y) }
        nudgedAt = t
        let v = hypot(vel.x, vel.y)
        if v > 0.02 { dir = (vel.x / v, vel.y / v) }
    }
    static var fingerSpeed: Double { now() - nudgedAt > 0.06 ? 0 : hypot(vel.x, vel.y) }

    // The cached target, if it is fresh and the point is on it (or within `slack` of it).
    static func onTarget(_ p: CGPoint, slack: Double) -> CGRect? {
        guard magnet, held == nil, let h = target, !h.frame.isNull, now() - h.time < freshFor,
              h.frame.insetBy(dx: -slack, dy: -slack).contains(p) else { return nil }
        return h.frame
    }

    // The gain for this nudge: 1 unless the pointer is (heading) onto a target and the finger is slow.
    // Eased toward its aim over gainEase ms rather than switched: the hit test answers a moment late, and a jump
    // from full speed to half (or back) at a button's edge feels like the pointer catching.
    static func friction() -> Double {
        var aim = 1.0
        if onTarget(CGPoint(x: cursor.x + moves.x, y: cursor.y + moves.y), slack: 2) != nil {
            let t = min(max((hypot(vel.x, vel.y) - frictionFrom) / (frictionTo - frictionFrom), 0), 1)
            aim = frictionGain + (1 - frictionGain) * t * t * (3 - 2 * t)
        }
        let t = now(), dt = (t - gainAt) * 1000
        gain = dt > 150 ? aim : gain + (aim - gain) * (1 - exp(-dt / gainEase))   // a new movement starts at its aim
        gainAt = t
        return gain
    }

    // A click, a scroll, a reset or the setting off: what was under the pointer may have changed or moved, and an
    // answer still on its way is for the old state (epoch).
    static func forget() { target = nil; drifting = false; pulled = 0; gain = 1; epoch += 1 }

    // Ask what is under the pointer: at most every askEvery, one question at a time, and once more where it
    // comes to rest (with the probes around it, for a target just short of the pointer).
    static func want() {
        guard magnet, held == nil else { return }
        if asking || askLater { return }
        let wait = askedAt + askEvery - now()
        if wait > 0 {
            askLater = true
            queue.asyncAfter(deadline: .now() + wait) { askLater = false; want() }
            return
        }
        asking = true; askedAt = now()
        let p = cursor, rest = moves.isEmpty, d = dir, e = epoch
        Assist.queue.async {
            let h = Assist.hit(at: p, rest: rest, dir: d)
            queue.async { got(h, e) }
        }
    }

    static func got(_ h: Assist.Hit, _ e: Int) {
        asking = false
        guard e == epoch, magnet else { return }
        if target.map({ !$0.frame.equalTo(h.frame) }) ?? true { pulled = 0 }   // a new target: a new budget
        target = h
        if hypot(cursor.x - h.at.x, cursor.y - h.at.y) >= 1 || (moves.isEmpty && !h.rest) { want() }
        if !drifting { drifting = true; kick() }                                // the tick decides; it stops if not
    }

    // One tick of the magnet: toward the target's centre band (its middle, past min(30%, 8 pt) from each edge),
    // a share of the way each tick, capped, and not on an axis the finger was leaving it along. False when done.
    static func pull(_ dt: Double) -> Bool {
        // Only once the finger is still: pulling under a moving finger fights it, and that reads as a stutter.
        let still = now() - nudgedAt
        guard !touching, !ending, !gliding, scrolls.isEmpty, moves.isEmpty, pulled < maxPull, still >= stoppedFor,
              still < pullFor, let f = onTarget(cursor, slack: reach) else {
            // Just stopped on (or near) something: keep the pump going the few ms until the finger counts as still.
            return still < stoppedFor && magnet && held == nil && moves.isEmpty && target != nil && !touching && !gliding
        }
        func off(_ c: Double, _ lo: Double, _ hi: Double, _ d: Double) -> Double {
            let m = min((hi - lo) * 0.3, 8), a = lo + m, b = hi - m
            let o = c < a ? a - c : c > b ? b - c : 0
            return o * d < -0.3 * abs(o) ? 0 : o                              // leaving along this axis: let it go
        }
        let ox = off(cursor.x, f.minX, f.maxX, dir.x), oy = off(cursor.y, f.minY, f.maxY, dir.y)
        let dist = hypot(ox, oy)
        guard dist >= 0.5 else { return false }
        let k = 1 - pow(1 - pullShare, dt / 8)
        let step = min(dist * k, pullStep * dt / 8, maxPull - pulled)
        pulled += step
        move(ox / dist * step, oy / dist * step)
        return true
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
        if !moves.isEmpty { let s = moves.step(share(pointerShare), tiny: 0.5); move(s.x, s.y); want() }
        drifting = pull(dt)
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
        moves = Lag(); forget(); vel = (0, 0); dir = (0, 0)
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
        let b = CGGetDisplaysWithPoint(from, 1, &id, &n) == .success && n > 0 ? CGDisplayBounds(id) : CGDisplayBounds(Input.screen)
        return CGPoint(x: min(max(p.x, b.minX), b.maxX - 1), y: min(max(p.y, b.minY), b.maxY - 1))
    }

    static func button(_ type: CGEventType, _ right: Bool, _ count: Int, _ j: [String: Any]) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: cursor, mouseButton: right ? .right : .left) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        e.flags = Input.flags(j)
        post(e)
    }
}

// ---------- what is under the pointer, for the trackpad's target assistance ----------
// Hit tests run here, never on Pad's queue: an app slow to answer Accessibility (Chrome, busy) only makes the
// answer late, and Pad ignores late answers. Each call waits at most `timeout`; any failure is "nothing there".
enum Assist {
    struct Hit { var at: CGPoint; var frame: CGRect; var rest: Bool; var time: Double }   // frame .null: nothing
    static var queue: DispatchQueue { Focus.queue }                    // one queue for every AX call: the messaging timeout is process-wide
    static let sys = AXUIElementCreateSystemWide()
    static let timeout: Float = 0.08
    // Clickable by role. Anything else counts if it offers AXPress (web buttons and links that are divs, images).
    static let clickRoles: Set<String> = ["AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXCheckBox",
        "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab", "AXDisclosureTriangle", "AXDockItem", "AXIncrementor"]
    // Never a target, and nothing above them is either: text to click into, and the containers of everything.
    static let stopRoles: Set<String> = ["AXTextArea", "AXTextField", "AXSearchField", "AXComboBox", "AXSecureTextField",
        "AXWebArea", "AXScrollArea", "AXWindow", "AXApplication", "AXSheet", "AXDrawer", "AXSlider", "AXScrollBar",
        "AXSplitter", "AXTable", "AXOutline", "AXBrowser", "AXList", "AXMenuBar", "AXMenu"]
    static let textRoles: Set<String> = ["AXTextArea", "AXTextField", "AXSearchField", "AXComboBox", "AXSecureTextField", "AXSlider"]
    static let maxSize = CGSize(width: 260, height: 120)                 // bigger is a container, not a button

    static func hit(at p: CGPoint, rest: Bool, dir: (x: Double, y: Double)) -> Hit {
        let t0 = Pad.now()
        func done(_ f: CGRect) -> Hit { Hit(at: p, frame: f, rest: rest, time: Pad.now()) }
        guard AXIsProcessTrusted() else { return done(.null) }
        let (f, blocking) = clickable(at: p)
        if !f.isNull || !rest || blocking { return done(f) }
        // At rest on nothing: a target just ahead of where the finger was going, or to either side of it (not
        // behind: the pointer left that one). Only one stop's worth, and not if the first answer was already slow.
        guard Pad.now() - t0 < 0.05 else { return done(.null) }
        let d = hypot(dir.x, dir.y) > 0.5 ? dir : (x: 1.0, y: 0.0)
        let ahead = [(d.x, d.y), (-d.y, d.x), (d.y, -d.x)] + (hypot(dir.x, dir.y) > 0.5 ? [] : [(-1.0, 0.0)])
        for (ux, uy) in ahead {
            let q = CGPoint(x: p.x + ux * Pad.reach, y: p.y + uy * Pad.reach)
            let g = clickable(at: q).frame
            if !g.isNull && g.insetBy(dx: -Pad.reach, dy: -Pad.reach).contains(p) { return done(g) }
        }
        return done(.null)
    }

    // The frame of the clickable element at p (or .null), and whether p is on something that rules out a pull
    // toward a neighbour (a text field: clicking near its edge is clicking into it).
    static func clickable(at p: CGPoint) -> (frame: CGRect, blocking: Bool) {
        AXUIElementSetMessagingTimeout(sys, timeout)
        var hitRef: AXUIElement?
        guard AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &hitRef) == .success, var el = hitRef else { return (.null, false) }
        var pressable: CGRect?
        for level in 0...3 {
            AXUIElementSetMessagingTimeout(el, timeout)
            guard let a = attributes(el) else { break }
            if stopRoles.contains(a.role) { return (.null, level == 0 && textRoles.contains(a.role)) }
            if a.frame.isNull || a.frame.width > maxSize.width || a.frame.height > maxSize.height { break }
            if !a.frame.insetBy(dx: -2, dy: -2).contains(p) { break }            // a frame that is not where it was hit
            if clickRoles.contains(a.role) { return (a.frame, false) }
            if pressable == nil && presses(el) { pressable = a.frame }
            guard let up = a.parent else { break }
            if role(up) == "AXTabGroup" { return (a.frame, false) }               // a tab, whatever it calls itself
            el = up
        }
        return (pressable ?? .null, false)
    }

    // Role, frame and parent in one round trip to the app.
    static func attributes(_ el: AXUIElement) -> (role: String, frame: CGRect, parent: AXUIElement?)? {
        let names = [kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXParentAttribute] as CFArray
        var out: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, names, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
              let v = out as? [AnyObject], v.count == 4, let role = v[0] as? String else { return nil }
        var pos = CGPoint.zero, size = CGSize.zero, frame = CGRect.null
        if CFGetTypeID(v[1]) == AXValueGetTypeID(), CFGetTypeID(v[2]) == AXValueGetTypeID(),
           AXValueGetValue(v[1] as! AXValue, .cgPoint, &pos), AXValueGetValue(v[2] as! AXValue, .cgSize, &size),
           size.width > 0, size.height > 0 { frame = CGRect(origin: pos, size: size) }
        let parent = CFGetTypeID(v[3]) == AXUIElementGetTypeID() ? (v[3] as! AXUIElement) : nil
        return (role, frame, parent)
    }
    static func role(_ el: AXUIElement) -> String {
        AXUIElementSetMessagingTimeout(el, timeout)
        var r: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &r) == .success ? (r as? String) ?? "" : ""
    }
    static func presses(_ el: AXUIElement) -> Bool {
        var names: CFArray?
        return AXUIElementCopyActionNames(el, &names) == .success && ((names as? [String]) ?? []).contains(kAXPressAction as String)
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
    // Quitting Seer takes the virtual screen with it (as would the process ending: WindowServer drops a dead client's).
    NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
        VirtualScreen.drop("Seer quit")
    }

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
    capture.enqueue { await $0.stop() }
}

func dispatch(_ j: [String: Any]) {
    switch j["cmd"] as? String {
    case "start":
        let maxWidth = (j["maxWidth"] as? Int) ?? 1512, fps = (j["fps"] as? Int) ?? 30, bitrate = (j["bitrate"] as? Int) ?? 3_000_000
        let virtual = (j["virtual"] as? Bool) ?? false                  // stream the virtual screen even with a real one (testing)
        capture.enqueue { await $0.start(maxWidth: maxWidth, fps: fps, bitrate: bitrate, virtual: virtual) }
    case "stop": Pad.queue.async { Pad.reset() }; capture.enqueue { await $0.stop() }
    case "keyframe": capture.keyframe()
    case "input":
        if !AXIsProcessTrusted() { link.status(["error": "accessibility"]); return }   // the service words it
        DispatchQueue.main.async { Input.handle(j) }
    case "ping": link.status(["pong": true, "accessibility": AXIsProcessTrusted(), "capturing": capture.running])
    default: break
    }
}

// Ask for Accessibility once at launch (Screen Recording is asked for by the first capture).
