# Release Guide

This file keeps release steps out of `README.md`.

## npm publish (public)

1. Login and confirm account:

```bash
npm login
npm whoami
npm config get registry
```

2. Use release script (recommended):

```bash
npm run release:patch
# or: npm run release:minor
# or: npm run release:major
```

Optional flags:

```bash
bash ./scripts/release.sh patch --otp 123456
bash ./scripts/release.sh patch --commit-message "chore: release %s"
bash ./scripts/release.sh patch --skip-publish
```

3. What script does:

- run on `main`
- fetch `origin/main` and stop if local `main` is behind remote
- require a clean working tree before releasing
- run `npm run check`
- run `npm version <bump>`
- run `npm run publish:dry-run`
- push `main` and tags to GitHub
- publish to npm (`--access public`)

Notes:

- Package is scoped (`@rabithua/xcdev`), first publish must use `--access public` (already included in script).
- Commit or stash local changes before running the release script; it no longer auto-stages arbitrary files.
- Release push now happens before npm publish so the Git tag and `main` stay ahead of the registry instead of the other way around.
- If 2FA is enabled on npm, finish OTP verification during publish.

## GitHub push

1. Commit local changes:

```bash
git add .
git commit -m "chore: release updates"
```

2. Push main branch:

```bash
git push -u origin main
```

## Common errors

- `E401` / `E403` when publishing npm: wrong npm account or missing package owner permission.
- `Permission denied` when pushing GitHub: SSH key/token has no write permission.
- Push rejected on protected branch: open PR and pass required checks first.
