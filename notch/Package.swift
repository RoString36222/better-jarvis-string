// swift-tools-version:5.9
// ZEN Notch: a tiny arc beside the Mac's notch that stands in for ZEN while its
// window is hidden. Builds with the Command Line Tools alone (no Xcode):
// `swift build -c release`, then scripts/install.sh bundles and signs the .app.
import PackageDescription

let package = Package(
    name: "ZENNotch",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "ZENNotch", path: "Sources/ZENNotch"),
    ]
)
