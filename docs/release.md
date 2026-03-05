# Release Guide

This file keeps release steps out of `README.md`.

## npm publish (public)

1. Login and confirm account:

```bash
npm login
npm whoami
npm config get registry
```

2. Run local checks:

```bash
npm run check
npm run publish:dry-run
```

3. Publish:

```bash
npm run publish:npm
```

Notes:

- Package is scoped (`@rabithua/xcdev`), first publish must use `--access public` (already included in script).
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
