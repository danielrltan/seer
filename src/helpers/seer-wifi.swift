// seer-wifi join <ssid>   (password on stdin, so it never shows in `ps`)
// Joins a Wi-Fi network through CoreWLAN: an SSID-filtered scan, then associate with the network it returns.
// macOS 26 redacts SSIDs for tools without Location permission, but the filtered scan still returns the
// network to associate with.
// Prints joined | not-found | error: <why>; exit 0 / 2 / 1.
import CoreWLAN
import Foundation

let args = CommandLine.arguments
guard args.count == 3, args[1] == "join" else {
    FileHandle.standardError.write("usage: seer-wifi join <ssid>  (password on stdin)\n".data(using: .utf8)!)
    exit(64)
}
let ssid = args[2]
let password = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "")
    .trimmingCharacters(in: .newlines)

guard let interface = CWWiFiClient.shared().interface() else { print("error: no Wi-Fi interface"); exit(1) }
do {
    if !interface.powerOn() { try interface.setPower(true) }
    let networks = try interface.scanForNetworks(withSSID: ssid.data(using: .utf8))
    guard let network = networks.first else { print("not-found"); exit(2) }
    try interface.associate(to: network, password: password.isEmpty ? nil : password)
    print("joined")
} catch {
    print("error: \(error.localizedDescription)")
    exit(1)
}
