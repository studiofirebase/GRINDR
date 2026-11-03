#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
artifacts="$root/src-tauri/target/release/artifacts"

if [[ -n "${APP_PATH:-}" ]]; then
	app="$APP_PATH"
else
	app=""
	latest=0
	for target in universal-apple-darwin aarch64-apple-darwin x86_64-apple-darwin; do
		for candidate in "$root/src-tauri/target/$target/release/bundle/macos/"*.app; do
			[[ -d "$candidate" ]] || continue
			built="$(stat -f '%m' "$candidate/Contents/MacOS/open-grind")"
			if (( built > latest )); then
				app="$candidate"
				latest="$built"
			fi
		done
	done
fi

if [[ ! -d "$app" ]]; then
	echo "App macOS não encontrada: $app" >&2
	echo "Gere primeiro o app com: nix run .#build-macos" >&2
	exit 1
fi

version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
product_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$app/Contents/Info.plist")"
mkdir -p "$artifacts"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

ditto "$app" "$staging/$product_name.app"
if ! codesign --verify --deep --strict "$staging/$product_name.app" >/dev/null 2>&1; then
	codesign --force --deep --sign - --options runtime "$staging/$product_name.app"
fi
codesign --verify --deep --strict "$staging/$product_name.app"
ln -s /Applications "$staging/Applications"
cp "$root/scripts/configure-openrouter.command" "$staging/Configurar OpenRouter.command"
cp "$root/docs/INSTALACAO-MACOS.md" "$staging/Leia-me - Grindr Modificado V1.md"
chmod 755 "$staging/Configurar OpenRouter.command"

output="$artifacts/grindr-modificado-v1-macos.dmg"
rm -f "$output"
hdiutil create \
	-volname "$product_name $version" \
	-srcfolder "$staging" \
	-ov \
	-format UDZO \
	"$output"

echo "Instalador criado: $output"
