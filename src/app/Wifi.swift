// Seer wifi join <ssid>   (password on stdin, so it never shows in `ps`)
// Seer wifi scan          (what the Mac can see: count, and names when macOS does not redact them)
// Seer wifi status        (the current Wi-Fi link: signal, noise, rate)
// Joins a Wi-Fi network through CoreWLAN: an SSID-filtered scan, then associate with the network it returns.
// macOS 26 redacts SSIDs for tools without Location permission, but the filtered scan still returns the
// network to associate with. iPhones name their hotspot with a curly apostrophe (Daniel’s iPhone) that a
// typed straight one does not match, so both spellings are tried.
// join prints joined | not-found | error: <why>; exit 0 / 2 / 1.
import CoreWLAN
import Foundation

// `Seer wifi ...`: the Wi-Fi helper as a subcommand of the app binary. args: [status|scan] or [join, ssid].
func wifiMain(_ args: [String]) -> Never {
    guard let interface = CWWiFiClient.shared().interface() else { print("error: no Wi-Fi interface"); exit(1) }

    // seer-wifi status: the Wi-Fi link as JSON (the network's name is redacted without Location permission).
    if args.count == 1, args[0] == "status" {
        let o: [String: Any] = ["power": interface.powerOn(), "rssi": interface.rssiValue(), "noise": interface.noiseMeasurement(),
                                "txRate": interface.transmitRate(), "ssid": interface.ssid() ?? NSNull()]
        print(String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)!)
        exit(0)
    }

    if args.count == 1, args[0] == "scan" {
        do {
            let all = try interface.scanForNetworks(withSSID: nil)
            print("networks: \(all.count)")
            for n in all.sorted(by: { $0.rssiValue > $1.rssiValue }) {
                print("  \(n.ssid ?? "<redacted>")  rssi \(n.rssiValue)  channel \(n.wlanChannel?.channelNumber ?? 0)")
            }
        } catch { print("error: \(error.localizedDescription)"); exit(1) }
        exit(0)
    }

    guard args.count == 2, args[0] == "join" else {
        FileHandle.standardError.write("usage: Seer wifi join <ssid>  (password on stdin) | seer-wifi scan\n".data(using: .utf8)!)
        exit(64)
    }
    let ssid = args[1]
    let password = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "")
        .trimmingCharacters(in: .newlines)

    var names = [ssid]
    for (a, b) in [("'", "\u{2019}"), ("\u{2019}", "'")] where ssid.contains(a) { names.append(ssid.replacingOccurrences(of: a, with: b)) }

    // An iPhone hotspot that is still waking up, or a Mac still leaving its last network, answers the first
    // association with tmpErr; it usually takes on a fresh scan. Third try: leave the current network first.
    var lastError: Error?
    var seen = false
    do { if !interface.powerOn() { try interface.setPower(true) } } catch { print("error: \(error.localizedDescription)"); exit(1) }
    for attempt in 1...3 {
        if attempt == 3 { interface.disassociate(); Thread.sleep(forTimeInterval: 1) }
        for name in names {
            guard let network = (try? interface.scanForNetworks(withSSID: name.data(using: .utf8)))?.first else { continue }
            seen = true
            do {
                try interface.associate(to: network, password: password.isEmpty ? nil : password)
                print("joined")
                exit(0)
            } catch { lastError = error }
        }
        Thread.sleep(forTimeInterval: 2)
    }
    if !seen { print("not-found"); exit(2) }
    let code = (lastError as NSError?)?.code ?? 0
    print("error: \(lastError?.localizedDescription ?? "unknown") (code \(code)\(code == -3924 || code == -3906 ? "; check the password" : ""))")
    exit(1)
}
