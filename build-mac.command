#!/bin/sh
# Builds the macOS app (.dmg and .zip for Apple Silicon and Intel) into the release folder: double-click this file.
# Only Node.js 22.12 or newer is needed; npm puts the build tools in node_modules, nothing is installed on the system.
cd "$(dirname "$0")" || exit 1

main() {
  # The usual Node.js locations, in case the shell setup does not add them.
  PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js was not found. Node.js 22.12 or newer is needed: https://nodejs.org"
    return 1
  fi
  if ! node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)"; then
    echo "Node.js 22.12 or newer is needed. This Mac has: $(node -v)"
    return 1
  fi
  # Without the command line tools git only offers to install them, so it is used only when they are there.
  if [ -d .git ] && xcode-select -p >/dev/null 2>&1; then
    echo "Getting the latest code..."
    git pull --ff-only || echo "Could not get the latest code, building the current one."
  fi
  # npm keeps its download cache in the project too, so a damaged cache in the home folder cannot break the build.
  export npm_config_cache="$PWD/.npm-cache"
  echo "Installing the build tools..."
  npm ci --no-audit --no-fund || { echo "Installing failed."; return 1; }
  echo "Building..."
  # Unsigned build; the lower priority keeps the Mac responsive while it compresses.
  CSC_IDENTITY_AUTO_DISCOVERY=false nice -n 10 npm run dist:mac || { echo "Build failed."; return 1; }
  echo "Done. The app is in the release folder."
  open release
}

# main is read in full before it runs, so a pull that changes this file is harmless.
main; exit
