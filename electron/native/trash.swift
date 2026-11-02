// Moves each argument to the Trash and prints where macOS actually put it.
//
// Electron's shell.trashItem discards the resulting URL, and the Trash cannot be listed without
// Full Disk Access. Guessing the landing name does not work: on a collision macOS appends a
// timestamp ("report.pdf 22-29-45-142.pdf"), and a guess can match an older, unrelated item that
// already had the same name. NSFileManager returns the real path, so Put back can rely on it.
//
// Output, one line per argument, tab-separated:
//   ok    <resulting path>
//   err   <EPERM|ENOENT|EIO>  <message>
import Foundation

func code(for error: Error) -> String {
  let ns = error as NSError
  if ns.domain == NSCocoaErrorDomain {
    switch ns.code {
    case NSFileWriteNoPermissionError, NSFileReadNoPermissionError: return "EPERM"
    case NSFileNoSuchFileError, NSFileReadNoSuchFileError: return "ENOENT"
    default: break
    }
  }
  // -5000 is afpAccessDenied: what a root-owned bundle reports underneath a generic failure.
  if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSOSStatusErrorDomain, underlying.code == -5000 {
    return "EPERM"
  }
  if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain {
    switch Int32(underlying.code) {
    case EPERM, EACCES: return "EPERM"
    case ENOENT: return "ENOENT"
    default: break
    }
  }
  return "EIO"
}

func clean(_ text: String) -> String {
  text.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
}

for path in CommandLine.arguments.dropFirst() {
  var resulting: NSURL?
  do {
    try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: &resulting)
    if let landed = resulting?.path { print("ok\t\(clean(landed))") }
    else { print("err\tEIO\tmacOS did not report where the item was moved") }
  } catch {
    print("err\t\(code(for: error))\t\(clean(error.localizedDescription))")
  }
}
