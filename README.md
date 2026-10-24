# xcdev — deprecated

This tool was retired locally on 2026-10-24. Use Xcode's native commands for
device discovery, builds, installation, and launch. Do not install this package
or add it to project instructions, dependencies, or scripts.

This repository retains its source, tests, and Git history for reference. The
package is private and its npm publish/release scripts have been removed. This
retirement does not deprecate previously published npm versions or archive the
remote GitHub repository.

## Native real-device workflow

Run these commands from your app's repository with Xcode selected and the target
device connected, trusted, and available for development.

List connected devices, then copy the target's UDID into `DEVICE_ID`:

```bash
xcrun devicectl list devices
DEVICE_ID='replace-with-target-device-udid'
```

Inspect the project's schemes and available destinations:

```bash
xcodebuild -list -project Example.xcodeproj
xcodebuild -showdestinations -project Example.xcodeproj -scheme Example
```

Replace `Example.xcodeproj` and `Example` with your project and app scheme. For a
workspace, replace `-project Example.xcodeproj` with
`-workspace Example.xcworkspace`.

Build a signed Debug app into an explicit output directory:

```bash
BUILD_ROOT="$PWD/.build/device"
xcodebuild -project Example.xcodeproj -scheme Example \
  -configuration Debug -destination "id=$DEVICE_ID" \
  -derivedDataPath "$BUILD_ROOT" build
```

Keep the project's normal device signing configuration enabled. Complete signing
or trusted macro approval in Xcode if the build requires it. Continue only after
the build succeeds.

Use the actual app product name in the bundle path, then install and launch it:

```bash
APP_BUNDLE="$BUILD_ROOT/Build/Products/Debug-iphoneos/Example.app"
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_BUNDLE/Info.plist")
xcrun devicectl device install app --device "$DEVICE_ID" "$APP_BUNDLE"
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID"
```

For an attached app console, use:

```bash
xcrun devicectl device process launch --device "$DEVICE_ID" \
  --terminate-existing --console "$BUNDLE_ID"
```

No tool-specific environment file or Node.js package is needed for these commands.

## Source maintenance

`npm test` and `npm run check` remain available for inspecting the retained source.
The historical release script is retained as source only; do not run it. See
[retirement status](docs/release.md).
