import ApplicationServices
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// ScreenCaptureKit and AX must run in the same signed app that the user enables in Settings.
@available(macOS 14.0, *)
private actor PrimaryDisplay {
    static let shared = PrimaryDisplay()
    var filter: SCContentFilter?
    var lastDisplay: CGDirectDisplayID?
    var size = CGSize.zero

    func jpeg(display: UInt32, edge: Int, sharp: Bool) async throws -> Data {
        let id = display == 0 ? CGMainDisplayID() : display
        let bounds = CGDisplayBounds(id).size
        if filter == nil || lastDisplay != id || bounds != size {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == id }),
                  bounds.width > 0, bounds.height > 0 else { throw CaptureError.unavailable }
            filter = SCContentFilter(display: display, excludingWindows: [])
            lastDisplay = id
            size = bounds
        }
        guard let filter = filter else { throw CaptureError.unavailable }
        let config = SCStreamConfiguration()
        // Stream dimensions are pixels. CGDisplayBounds on Retina is in logical points.
        let pixelsPerPoint = CGFloat(filter.pointPixelScale)
        let width = filter.contentRect.width * pixelsPerPoint
        let height = filter.contentRect.height * pixelsPerPoint
        guard width > 0, height > 0 else { throw CaptureError.unavailable }
        let scale = min(1, CGFloat(edge) / max(width, height))
        config.width = max(1, Int((width * scale).rounded()))
        config.height = max(1, Int((height * scale).rounded()))
        config.showsCursor = false
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            self.filter = nil
            throw error
        }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw CaptureError.unavailable
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: sharp ? 0.95 : 0.80] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw CaptureError.unavailable }
        return data as Data
    }
}

private enum CaptureError: Error { case unavailable }

// The task owns this result until it signals. A timeout never leaves a task holding the caller's pointers.
private final class CaptureResult: @unchecked Sendable {
    let finished = DispatchSemaphore(value: 0)
    var jpeg: Data?
    var status: Int32 = 2
}

@_cdecl("rc_capture_jpeg")
public func captureJPEG(_ output: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>,
                        _ length: UnsafeMutablePointer<Int>) -> Int32 {
    return captureProfileJPEG(1920, 0, output, length)
}

@_cdecl("rc_capture_jpeg_for_profile")
public func captureProfileJPEG(_ edge: Int32, _ sharp: Int32,
                               _ output: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>,
                               _ length: UnsafeMutablePointer<Int>) -> Int32 {
    return captureDisplayJPEG(0, edge, sharp, output, length)
}

@_cdecl("rc_capture_display_jpeg")
public func captureDisplayJPEG(_ display: UInt32, _ edge: Int32, _ sharp: Int32,
                               _ output: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>,
                               _ length: UnsafeMutablePointer<Int>) -> Int32 {
    output.pointee = nil
    length.pointee = 0
    guard #available(macOS 14.0, *) else { return 2 }
    let result = CaptureResult()
    let task = Task {
        do {
            result.jpeg = try await PrimaryDisplay.shared.jpeg(display: display, edge: min(3840, max(1, Int(edge))), sharp: sharp != 0)
            result.status = 0
        } catch {
            let code = error as NSError
            if code.domain == SCStreamError.errorDomain && code.code == SCStreamError.Code.userDeclined.rawValue {
                result.status = 1
            }
        }
        result.finished.signal()
    }
    guard result.finished.wait(timeout: .now() + 10) == .success else {
        task.cancel()
        return 2
    }
    guard let bytes = result.jpeg, !bytes.isEmpty, bytes.count <= 16 * 1024 * 1024 else {
        return result.status == 0 ? 2 : result.status
    }
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes.count)
    bytes.copyBytes(to: buffer, count: bytes.count)
    output.pointee = buffer
    length.pointee = bytes.count
    return 0
}

@_cdecl("rc_free_image")
public func freeImage(_ bytes: UnsafeMutablePointer<UInt8>?) { bytes?.deallocate() }

@_cdecl("rc_focused_editable")
public func focusedEditable() -> Int32 {
    guard AXIsProcessTrusted() else { return 0 }
    let root = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(root, 0.4)
    var element: CFTypeRef?
    guard AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute as CFString, &element) == .success,
          let element = element, CFGetTypeID(element) == AXUIElementGetTypeID() else { return 0 }
    let focused = element as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, 0.4)
    var role: CFTypeRef?
    var writable = DarwinBoolean(false)
    _ = AXUIElementCopyAttributeValue(focused, kAXRoleAttribute as CFString, &role)
    _ = AXUIElementIsAttributeSettable(focused, kAXSelectedTextAttribute as CFString, &writable)
    return ["AXTextField", "AXTextArea", "AXComboBox"].contains(role as? String ?? "") || writable.boolValue ? 1 : 0
}
