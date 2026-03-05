#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  scripts/release.sh <patch|minor|major|prepatch|preminor|premajor|prerelease> [--otp <code>] [--commit-message <msg>] [--skip-publish]

Examples:
  scripts/release.sh patch
  scripts/release.sh minor --otp 123456
  scripts/release.sh patch --commit-message "feat: update device config handling"
  scripts/release.sh patch --skip-publish
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

BUMP="$1"
shift

OTP="${NPM_OTP:-}"
COMMIT_MESSAGE="${RELEASE_COMMIT_MESSAGE:-chore: prepare release}"
SKIP_PUBLISH="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --otp)
      OTP="${2:-}"
      shift 2
      ;;
    --skip-publish)
      SKIP_PUBLISH="1"
      shift
      ;;
    --commit-message)
      COMMIT_MESSAGE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

case "$BUMP" in
  patch|minor|major|prepatch|preminor|premajor|prerelease) ;;
  *)
    echo "Invalid version bump type: $BUMP"
    usage
    exit 1
    ;;
esac

if ! command -v git >/dev/null 2>&1; then
  echo "git is required."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Current branch is '$CURRENT_BRANCH'. Release must run on 'main'."
  exit 1
fi

echo "==> npm run check"
npm run check

echo "==> npm run publish:dry-run"
npm run publish:dry-run

if [[ -n "$(git status --porcelain)" ]]; then
  echo "==> git add -A"
  git add -A
  echo "==> git commit -m \"$COMMIT_MESSAGE\""
  git commit -m "$COMMIT_MESSAGE"
fi

echo "==> npm version $BUMP"
npm version "$BUMP"

NEW_VERSION="$(node -p "require('./package.json').version")"
echo "New version: $NEW_VERSION"

echo "==> git push origin main --follow-tags"
git push origin main --follow-tags

if [[ "$SKIP_PUBLISH" == "1" ]]; then
  echo "Skip npm publish enabled. Release commit/tag pushed, package not published."
  exit 0
fi

echo "==> npm publish --access public"
if [[ -n "$OTP" ]]; then
  npm publish --access public --otp="$OTP"
else
  npm publish --access public
fi

echo "Release completed: @rabithua/xcdev@$NEW_VERSION"
