# xcdev

A publishable npm CLI for:

- listing simulators and connected real devices
- building iOS projects with profiles
- running apps on simulator or real device

## Install

```bash
npm install -g @rabithua/xcdev
```

## Release (npm public)

1. Login npm:

```bash
npm login
```

2. Verify account and registry:

```bash
npm whoami
npm config get registry
```

3. Dry run package publish:

```bash
npm run publish:dry-run
```

4. Publish as public package:

```bash
npm run publish:npm
```

Notes:

- This package is scoped (`@rabithua/xcdev`), so `--access public` is required for first publish.
- If npm 2FA is enabled, complete the OTP challenge when publishing.
- If you get `403` / `E401`, verify you are logged in with the package owner account.

## Release (GitHub public repo)

If you cannot push or expose the repo publicly on GitHub, check:

1. Remote URL points to your GitHub repo:

```bash
git remote -v
```

2. Push branch:

```bash
git push -u origin main
```

3. On GitHub web UI:
- Open repository `Settings` -> `General`.
- Change repository visibility to `Public`.

Common issues:

- `Permission denied`: your GitHub account/token does not have write access.
- Push rejected: branch protection rules require PR/CI first.
- Repo still private: organization policy may block visibility changes.

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

`templates/.ios-dev.env.example`

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
