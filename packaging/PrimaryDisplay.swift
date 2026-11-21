import Foundation
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

@main
struct PrimaryDisplay {
    @available(macOS 14.0, *)
    static func capture() async throws {
        var filter: SCContentFilter?
        var lastDisplay: CGDirectDisplayID?
        var size = CGSize.zero
        while !FileHandle.standardInput.readData(ofLength: 1).isEmpty {
            let id = CGMainDisplayID()
            let bounds = CGDisplayBounds(id).size
            if lastDisplay != id || bounds != size {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first(where: { $0.displayID == id }) else { return }
                filter = SCContentFilter(display: display, excludingWindows: [])
                lastDisplay = id
                size = bounds
            }
            guard let filter = filter else { return }
            let config = SCStreamConfiguration()
            let scale = min(1, 1920 / max(size.width, size.height))
            config.width = max(1, Int(size.width * scale))
            config.height = max(1, Int(size.height * scale))
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let data = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return }
            CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return }
            var sizeBE = UInt32(data.length).bigEndian
            FileHandle.standardOutput.write(Data(bytes: &sizeBE, count: 4))
            FileHandle.standardOutput.write(data as Data)
        }
    }
    static func main() async throws {
        if CommandLine.arguments.dropFirst().first == "--editable" {
            let root = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(root, 0.4)
            var element: CFTypeRef?
            if AXUIElementCopyAttributeValue(root,kAXFocusedUIElementAttribute as CFString,&element) == .success,
               let element = element, CFGetTypeID(element) == AXUIElementGetTypeID() {
                let focused = element as! AXUIElement
                AXUIElementSetMessagingTimeout(focused, 0.4)
                var role: CFTypeRef?
                var writable = DarwinBoolean(false)
                _ = AXUIElementCopyAttributeValue(focused,kAXRoleAttribute as CFString,&role)
                _ = AXUIElementIsAttributeSettable(focused,kAXSelectedTextAttribute as CFString,&writable)
                if ["AXTextField","AXTextArea","AXComboBox"].contains(role as? String ?? "") || writable.boolValue {
                    print("1")
                }
            }
            return
        }
        if #available(macOS 14.0, *) { try await capture() }
    }
}
