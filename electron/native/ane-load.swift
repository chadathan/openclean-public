// Puts the Neural Engine to work so the NPU panel has something to show.
//
// Vision's feature-print request is one of the few built-in models that schedules on the
// ANE, which makes it a convenient load generator: no model file to ship, no download, and
// it runs from the command line. Run it, then watch the NPU panel go from Idle to Active.
//
// Built alongside the other native helpers and driven from the NPU panel's test button,
// because the Neural Engine sits at 0.00 W unless something asks it to work, and a panel
// that never moves is impossible to tell apart from a broken one.
//
//   openclean-ane-load [seconds]
//
// Roughly 2 W on an M1, against 0.00 W at rest.
import Vision
import CoreImage
import Foundation

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 15

let side = 640
let image = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: side, height: side))
guard let cgImage = CIContext().createCGImage(image, from: image.extent) else {
    FileHandle.standardError.write(Data("could not build the source image\n".utf8))
    exit(1)
}

print("Loading the Neural Engine for \(Int(seconds))s — watch the NPU panel.")
let deadline = Date().addingTimeInterval(seconds)
var runs = 0
while Date() < deadline {
    let request = VNGenerateImageFeaturePrintRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
        runs += 1
    } catch {
        FileHandle.standardError.write(Data("request failed: \(error)\n".utf8))
        exit(1)
    }
}
print("Done — \(runs) feature-print requests.")
