# OpenClean

OpenClean is a free macOS utility for understanding system activity and reviewing files that may be safe to remove. File scans and removal decisions stay on your Mac; OpenClean does not delete files automatically.

## Download and install

Requires an Apple silicon Mac.

```bash
curl -fsSL https://github.com/chadathan/openclean-releases/releases/latest/download/install.sh | bash
```

The installer downloads the latest app, verifies its SHA-256 checksum and code signature, then installs it in `/Applications` or `~/Applications`. Run the same command again to update.

To uninstall:

```bash
curl -fsSL https://github.com/chadathan/openclean-releases/releases/latest/download/uninstall.sh | bash
```

Browse [downloads and release notes](https://github.com/chadathan/openclean-releases/releases).

## Features

- System monitoring for CPU, memory, storage, battery, GPU, network, and thermals
- Cleanup scans with review-before-removal and Put Back records
- Application and developer-tool inventory with removal review
- File search, folder maps, and duplicate detection
- Process activity and low-storage alerts
- Permission Center for checking Full Disk Access

OpenClean has no account or sign-in requirement. Anonymous usage counts are sent only when analytics are configured for the build and enabled in Settings. They include page names and app/macOS versions, not file paths, scan results, or installed-app lists.

## Build from source

Requires macOS, Node.js/npm, and Xcode Command Line Tools (Clang and Swift).

```bash
npm ci
npm start
```

To create a macOS app directory:

```bash
npm run package:mac
```

## License

No license is currently provided. Public visibility does not grant permission to reuse or redistribute the source code.
