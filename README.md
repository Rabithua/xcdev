# xcdev

A publishable npm CLI for:

- listing simulators and connected real devices
- building iOS projects with profiles
- running apps on simulator or real device

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

xcdev build sim
xcdev build real

xcdev run sim
xcdev run real
```

`sim` / `real` are recommended default profiles.
Any profile name (such as `air`, `office-phone`) is user-defined in `.ios-dev.env`.

## Project Config

The CLI auto-discovers `.ios-dev.env` by searching upward from current directory.
If no config is found, it still works with auto-detected project/scheme and default profiles.

Create `.ios-dev.env` in the project root if you want stable project-specific settings.
You can start from:

`tools/ios-dev-cli/templates/.ios-dev.env.example`

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
IOS_PROFILE_REAL_TARGET="iPhone"
```
