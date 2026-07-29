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

The `xcdev` CLI offers the following commands for managing devices and building/running your iOS project.

### Listing Devices and Profiles

- `xcdev list devices`: Lists all available simulator and connected real devices.
- `xcdev list devices sim`: Lists only the available iOS simulators.
- `xcdev list devices real`: Lists only the currently connected real iOS devices.
- `xcdev list profiles`: Displays all the device profiles (e.g., specific simulators or real devices) that you have defined or are available as defaults.

### Setting Default Targets

You can assign a specific device name or pattern to your default `sim` and `real` profiles. This is useful for quickly targeting a preferred device.

- `xcdev set sim "iPhone Air"`: Sets the default simulator profile target to a simulator named "iPhone Air".
- `xcdev set sim --version 18.2 "iPhone Air"`: Sets the default simulator target and preferred iOS runtime version.
- `xcdev set real "Huawei Air"`: Sets the default real device profile target to a connected device matching "Huawei Air".
- `xcdev set scheme Rote`: Saves an explicit Xcode scheme in `.xcdev.env`.

### Building the Project

Builds the project for the specified profile without installing or running it. Builds are clean by default so the output cannot reuse stale compiled artifacts.

- `xcdev build sim`: Compiles the project targeting the default simulator.
- `xcdev build --version 18.2 sim`: Compiles the project targeting the default simulator on a matching iOS runtime version.
- `xcdev build real`: Compiles the project targeting the default connected real device.
- `xcdev build --scheme Rote sim`: Uses `Rote` for this build without changing `.xcdev.env`.
- `xcdev build --skip-macro-validation sim`: Bypasses Xcode's Swift macro validation for this build. Use this only after reviewing and trusting the macros involved.

### Running the Project

Performs a clean build, installs the newly built app, and launches it on the target device.

- `xcdev run sim`: Runs your application on the default simulator. By default, it boots the simulator and opens `Simulator.app` for the selected device.
- `xcdev run --version 18.2 sim`: Runs your application on the default simulator whose runtime contains `18.2`.
- `xcdev run real`: Runs your application on the default real device.
- `xcdev run --skip-macro-validation sim`: Bypasses Xcode's Swift macro validation for this run. Use this only for trusted macros.
- `xcdev run --logs real`: Runs on the default real device and keeps streaming that app's console logs until the app exits or you press `Ctrl-C`.

Use `xcdev run --no-open-simulator sim` if you want to keep the simulator app hidden while still running on the booted device.

`--logs` is supported for real-device runs. It relaunches any existing instance of the app so `devicectl` can attach its console after installation.

*(Note: `sim` and `real` are recommended default profile names. Any custom profile name, such as `office-phone`, can be used if defined in `.xcdev.env`.)*

`sim` / `real` are recommended default profiles.
Any profile name (such as `air`, `office-phone`) is user-defined in `.xcdev.env`.
If `real` target is not set, xcdev uses the first connected real device.

## Project Config

The CLI auto-discovers `.xcdev.env` by searching upward from current directory.
If no config is found, it still works with auto-detected project/scheme and default profiles.
Scheme discovery first looks for a scheme whose name matches the selected project or workspace.
It uses local `.xcscheme` metadata and resolved package identities to exclude package-only schemes;
schemes whose ownership cannot be determined remain candidates rather than being silently discarded.
If more than one plausible scheme remains, xcdev stops and asks you to set `IOS_SCHEME`,
run `xcdev set scheme <name>`, or pass `--scheme <name>`.

Create `.xcdev.env` in the project root if you want stable project-specific settings.
You can start from:

`templates/.xcdev.env.example`

Required keys:

- `IOS_PROJECT`
- `IOS_SCHEME`

Common optional keys:

- `IOS_CONFIGURATION`
- `IOS_BUNDLE_ID`
- `IOS_SIM_VERSION`
- `IOS_PROFILE_<NAME>_MODE`
- `IOS_PROFILE_<NAME>_TARGET`
- `IOS_PROFILE_<NAME>_VERSION`
- `IOS_OPEN_SIMULATOR` (`YES` by default; set to `NO` to avoid opening `Simulator.app` during `run`)
- `IOS_CLEAN_BUILD` (`YES` by default; set to `NO` to allow incremental Xcode builds)
- `IOS_SKIP_MACRO_VALIDATION` (`NO` by default; set to `YES` only to bypass validation for Swift macros you trust)
- `IOS_MONITOR_LOGS` (`NO` by default; set to `YES` to stream app logs after a real-device install)

Swift macro validation remains enabled by default. If Xcode reports that a macro must be
enabled before it can be used, review the macro and approve it by opening the project in
Xcode and building once. For trusted macros, you can explicitly bypass validation for one
command with `--skip-macro-validation`, or for the project with
`IOS_SKIP_MACRO_VALIDATION=YES`.

Example:

```bash
IOS_PROFILE_SIM_MODE="sim"
IOS_PROFILE_SIM_TARGET="iPhone"
IOS_PROFILE_SIM_VERSION="18.2"

IOS_PROFILE_REAL_MODE="real"
IOS_PROFILE_REAL_TARGET=".*"

# Keep Xcode macro validation enabled unless all macros have been reviewed and trusted.
IOS_SKIP_MACRO_VALIDATION="NO"
```
