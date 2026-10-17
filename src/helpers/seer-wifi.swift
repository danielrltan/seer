// seer-wifi join <ssid>   (password on stdin, so it never shows in `ps`)
// seer-wifi scan          (what the Mac can see: count, and names when macOS does not redact them)
// Joins a Wi-Fi network through CoreWLAN: an SSID-filtered scan, then associate with the network it returns.
// macOS 26 redacts SSIDs for tools without Location permission, but the filtered scan still returns the
// network to associate with. iPhones name their hotspot with a curly apostrophe (Daniel’s iPhone) that a
// typed straight one does not match, so both spellings are tried.
// join prints joined | not-found | error: <why>; exit 0 / 2 / 1.
import CoreWLAN
import Foundation

let args = CommandLine.arguments
guard let interface = CWWiFiClient.shared().interface() else { print("error: no Wi-Fi interface"); exit(1) }

if args.count == 2, args[1] == "scan" {
    do {
        let all = try interface.scanForNetworks(withSSID: nil)
        print("networks: \(all.count)")
        for n in all.sorted(by: { $0.rssiValue > $1.rssiValue }) {
            print("  \(n.ssid ?? "<redacted>")  rssi \(n.rssiValue)  channel \(n.wlanChannel?.channelNumber ?? 0)")
        }
    } catch { print("error: \(error.localizedDescription)"); exit(1) }
    exit(0)
}

guard args.count == 3, args[1] == "join" else {
    FileHandle.standardError.write("usage: seer-wifi join <ssid>  (password on stdin) | seer-wifi scan\n".data(using: .utf8)!)
    exit(64)
}
let ssid = args[2]
let password = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "")
    .trimmingCharacters(in: .newlines)

var names = [ssid]
for (a, b) in [("'", "\u{2019}"), ("\u{2019}", "'")] where ssid.contains(a) { names.append(ssid.replacingOccurrences(of: a, with: b)) }

do {
    if !interface.powerOn() { try interface.setPower(true) }
    for name in names {
        let networks = try interface.scanForNetworks(withSSID: name.data(using: .utf8))
        guard let network = networks.first else { continue }
        try interface.associate(to: network, password: password.isEmpty ? nil : password)
        print("joined")
        exit(0)
    }
    print("not-found")
    exit(2)
} catch {
    print("error: \(error.localizedDescription)")
    exit(1)
}
