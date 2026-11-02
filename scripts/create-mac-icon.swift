import AppKit
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    fputs("usage: create-mac-icon.swift <source-image> <destination.icns>\n", stderr)
    exit(2)
}

guard let source = NSImage(contentsOfFile: arguments[1]) else {
    fputs("Unable to read logo at \(arguments[1])\n", stderr)
    exit(1)
}

let outputURL = URL(fileURLWithPath: arguments[2])
try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)

// macOS lays every app icon out on the same grid: an 824-point rounded square centred on a
// 1024-point canvas, with the corners Apple's template uses. An icon that strays from that
// shape — this artwork is full-bleed and carries a soft glow past its own edge — is put on a
// grey plate by macOS 26 and turns to mush at Finder's list size. So the artwork is cropped to
// its own rounded square, the glow is cut off, and the result is placed on the grid.
let artworkInset: CGFloat = 54 / 1100      // where the artwork's rounded square begins, glow excluded
let gridInset: CGFloat = 100 / 1024        // Apple's margin around the icon shape
let cornerRatio: CGFloat = 0.2237          // corner radius as a share of the shape's width

func renderIcon(size: Int) -> Data {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fputs("Unable to create \(size)px icon\n", stderr)
        exit(1)
    }
    let side = CGFloat(size)
    let shape = NSRect(x: side * gridInset, y: side * gridInset, width: side * (1 - 2 * gridInset), height: side * (1 - 2 * gridInset))
    let sourceSide = source.size.width
    let crop = NSRect(x: sourceSide * artworkInset, y: sourceSide * artworkInset, width: sourceSide * (1 - 2 * artworkInset), height: sourceSide * (1 - 2 * artworkInset))

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    NSBezierPath(roundedRect: shape, xRadius: shape.width * cornerRatio, yRadius: shape.width * cornerRatio).addClip()
    source.draw(in: shape, from: crop, operation: .sourceOver, fraction: 1)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fputs("Unable to encode \(size)px icon\n", stderr)
        exit(1)
    }
    return png
}

// Every slot iconutil knows, including the @2x ones a Retina Finder list actually draws.
let iconset = outputURL.deletingLastPathComponent().appendingPathComponent("openclean.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    try renderIcon(size: points).write(to: iconset.appendingPathComponent("icon_\(points)x\(points).png"))
    try renderIcon(size: points * 2).write(to: iconset.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", outputURL.path]
try iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
guard iconutil.terminationStatus == 0 else {
    fputs("iconutil failed\n", stderr)
    exit(1)
}
let volumePNG: Data? = renderIcon(size: 512)

guard let volumePNG else {
    fputs("Unable to render volume icon\n", stderr)
    exit(1)
}
let temporaryPNG = outputURL.deletingLastPathComponent().appendingPathComponent("openclean-volume.png")
let volumeIconURL = outputURL.deletingLastPathComponent().appendingPathComponent("openclean-volume.icns")
try volumePNG.write(to: temporaryPNG, options: .atomic)
let sips = Process()
sips.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
sips.arguments = ["-s", "format", "icns", temporaryPNG.path, "--out", volumeIconURL.path]
try sips.run()
sips.waitUntilExit()
try? FileManager.default.removeItem(at: temporaryPNG)
guard sips.terminationStatus == 0 else {
    fputs("sips failed with status \(sips.terminationStatus)\n", stderr)
    exit(sips.terminationStatus)
}
print("Wrote \(outputURL.path)")
print("Wrote \(volumeIconURL.path)")
