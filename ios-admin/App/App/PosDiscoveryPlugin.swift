import Capacitor
import Foundation

/// Finds OneTap POS tills from the Admin app.
///
/// WKWebView hides the phone's own IP (WebRTC only reports `.local` names), so
/// the web scan could not tell which /24 to probe and only tried a few common
/// router subnets. This plugin gives it the Wi-Fi IPv4 and also browses the
/// till's Bonjour service (`_codeorbit-pos._tcp`, see mdnsAdvertiser.ts and
/// NSBonjourServices in Info.plist).
@objc(PosDiscoveryPlugin)
public class PosDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PosDiscoveryPlugin"
    public let jsName = "PosDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "localAddresses", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browse", returnType: CAPPluginReturnPromise),
    ]

    private var browses: [UUID: BonjourBrowse] = [:]

    @objc func localAddresses(_ call: CAPPluginCall) {
        call.resolve(["addresses": PosDiscoveryPlugin.wifiIpv4Addresses()])
    }

    @objc func browse(_ call: CAPPluginCall) {
        let timeoutMs = max(500, min(10_000, call.getInt("timeoutMs") ?? 3_000))
        DispatchQueue.main.async {
            let id = UUID()
            let browse = BonjourBrowse(timeout: Double(timeoutMs) / 1000) { [weak self] hosts in
                self?.browses[id] = nil
                call.resolve(["hosts": hosts])
            }
            self.browses[id] = browse
            browse.start()
        }
    }

    /// IPv4 addresses on Wi-Fi/Ethernet interfaces (en*), skipping loopback.
    static func wifiIpv4Addresses() -> [String] {
        var result: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return result }
        defer { freeifaddrs(ifaddr) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0,
                  let addr = ptr.pointee.ifa_addr,
                  addr.pointee.sa_family == UInt8(AF_INET)
            else { continue }
            let name = String(cString: ptr.pointee.ifa_name)
            guard name.hasPrefix("en") else { continue }
            if let ip = numericHost(addr), !result.contains(ip) { result.append(ip) }
        }
        return result
    }

    static func numericHost(_ addr: UnsafePointer<sockaddr>) -> String? {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let len = socklen_t(addr.pointee.sa_len)
        guard getnameinfo(addr, len, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
        else { return nil }
        return String(cString: host)
    }
}

/// One Bonjour browse: collect services for `timeout` seconds, resolve each,
/// then report every IPv4 + port found.
private final class BonjourBrowse: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private let browser = NetServiceBrowser()
    private let timeout: TimeInterval
    private let done: ([[String: Any]]) -> Void
    private var services: [NetService] = []
    private var hosts: [[String: Any]] = []
    private var finished = false

    init(timeout: TimeInterval, done: @escaping ([[String: Any]]) -> Void) {
        self.timeout = timeout
        self.done = done
    }

    func start() {
        browser.delegate = self
        browser.searchForServices(ofType: "_codeorbit-pos._tcp.", inDomain: "local.")
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            self?.finish()
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        browser.stop()
        services.forEach { $0.stop() }
        done(hosts)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        services.append(service)
        service.delegate = self
        service.resolve(withTimeout: max(1, timeout - 0.5))
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        finish()
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        var txt: [String: String] = [:]
        if let data = sender.txtRecordData() {
            for (key, value) in NetService.dictionary(fromTXTRecord: data) {
                txt[key] = String(data: value, encoding: .utf8) ?? ""
            }
        }
        var ips: [String] = []
        for data in sender.addresses ?? [] {
            data.withUnsafeBytes { raw in
                guard let base = raw.baseAddress else { return }
                let sa = base.assumingMemoryBound(to: sockaddr.self)
                guard sa.pointee.sa_family == UInt8(AF_INET),
                      let ip = PosDiscoveryPlugin.numericHost(sa) else { return }
                if !ips.contains(ip) { ips.append(ip) }
            }
        }
        if let lanHost = txt["lanHost"], !lanHost.isEmpty, !ips.contains(lanHost) {
            ips.append(lanHost)
        }
        for ip in ips {
            hosts.append([
                "name": sender.name,
                "host": ip,
                "httpPort": sender.port,
                "httpsPort": Int(txt["https"] ?? "") ?? 0,
                "restaurantName": txt["restaurantName"] ?? "",
                "businessCode": txt["businessCode"] ?? "",
            ])
        }
    }
}

/// Registers the app's own plugins (Main.storyboard points here).
class AdminBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PosDiscoveryPlugin())
    }
}
