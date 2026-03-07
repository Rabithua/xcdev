# xcdev

A publishable npm CLI for:

- listing simulators and connected real devices
- building iOS projects with profiles
- running apps on simulator or real device

## Prerequisites

- **OS**: macOS
- **Node.js**: >= 18
- **Xcode**: 15 or higher (relies on `xcodebuild`, `xcrun simctl`, `xcrun xctrace`, and `xcrun devicectl`).
- **Project**: A valid iOS project (`.xcodeproj` or `.xcworkspace`) with a buildable scheme.

## Install

```bash
npm install -g @rabithua/xcdev
```

## Commands

```bash
xcdev list devices
xcdev list devices sim
xcdev list devices real
xcdev list profiles
xcdev set sim "iPhone Air"
xcdev set real "Huawei Air"

xcdev build sim
xcdev build real

xcdev run sim
xcdev run real
```

`sim` / `real` are recommended default profiles.
Any profile name (such as `air`, `office-phone`) is user-defined in `.xcdev.env`.
If `real` target is not set, xcdev uses the first connected real device.

## Project Config

The CLI auto-discovers `.xcdev.env` by searching upward from current directory.
If no config is found, it still works with auto-detected project/scheme and default profiles.

Create `.xcdev.env` in the project root if you want stable project-specific settings.
You can start from:

`templates/.xcdev.env.example`

Required keys:

- `IOS_PROJECT`
- `IOS_SCHEME`

Common optional keys:

- `IOS_CONFIGURATION`
- `IOS_BUNDLE_ID`
- `IOS_PROFILE_<NAME>_MODE`
- `IOS_PROFILE_<NAME>_TARGET`

Example:

```bash
IOS_PROFILE_SIM_MODE="sim"
IOS_PROFILE_SIM_TARGET="iPhone"

IOS_PROFILE_REAL_MODE="real"
IOS_PROFILE_REAL_TARGET=".*"
```
