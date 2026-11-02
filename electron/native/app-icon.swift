// Prints one base64 PNG per path given, in order, or an empty line where macOS has nothing
// to offer. NSWorkspace is what Finder itself asks, so it resolves asset-catalog icons and
// hands back the generic "exec" badge for a plain command-line binary. Electron's own
// app.getFileIcon goes through a different path that returns a blank document icon here.
import AppKit

let side = 48.0

for path in CommandLine.arguments.dropFirst() {
  let source = NSWorkspace.shared.icon(forFile: path)
  let size = NSSize(width: side, height: side)
  let scaled = NSImage(size: size)
  scaled.lockFocus()
  source.draw(in: NSRect(origin: .zero, size: size))
  scaled.unlockFocus()
  guard let tiff = scaled.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:]) else {
    print("")
    continue
  }
  print(png.base64EncodedString())
}
