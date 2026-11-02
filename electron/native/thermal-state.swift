// Reports macOS's own thermal pressure level as a JSON line.
//
// ProcessInfo.thermalState is the public API for this and it has no C equivalent, which is
// why this is Swift. `pmset -g therm` is not the same thing: it reports whether a throttling
// event has ever been recorded, not the level the system is at now.
import Foundation

let name: String
switch ProcessInfo.processInfo.thermalState {
case .nominal: name = "nominal"
case .fair: name = "fair"
case .serious: name = "serious"
case .critical: name = "critical"
@unknown default: name = "unknown"
}
print("{\"state\":\"\(name)\"}")
