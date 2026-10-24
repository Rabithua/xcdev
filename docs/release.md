# Retirement status

The local tool was retired on 2026-10-24. Further releases from this checkout are
disabled: `package.json` sets `private: true`, and its npm publish and release
script entries have been removed.

Do not publish this checkout or run the historical `scripts/release.sh`; it is
retained only with the original source and Git history. This retirement does not
deprecate existing npm publications or archive the remote GitHub repository.

Use the independent native Xcode workflow in [README.md](../README.md) for app
development. Local source inspection remains available through `npm test` and
`npm run check`.
