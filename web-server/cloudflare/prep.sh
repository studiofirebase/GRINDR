#!/usr/bin/env bash
# Prepara o contexto de build do container: copia o crate Rust e o frontend
# ja compilado para dentro de web-server/cloudflare/ (onde esta o Dockerfile).
# Uso: ./prep.sh  (rode na raiz do repo com `bun run build` feito antes)
set -euo pipefail

CLOUDFLARE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_SERVER_DIR="$(dirname "$CLOUDFLARE_DIR")"
APP_ROOT="$(dirname "$WEB_SERVER_DIR")"

if [ ! -f "$APP_ROOT/build/index.html" ]; then
	echo "erro: $APP_ROOT/build/index.html nao existe; rode 'bun run build' na raiz do app primeiro" >&2
	exit 1
fi

rm -rf "$CLOUDFLARE_DIR/Cargo.toml" "$CLOUDFLARE_DIR/Cargo.lock" "$CLOUDFLARE_DIR/src" "$CLOUDFLARE_DIR/build"
cp "$WEB_SERVER_DIR/Cargo.toml" "$WEB_SERVER_DIR/Cargo.lock" "$CLOUDFLARE_DIR/"
cp -r "$WEB_SERVER_DIR/src" "$CLOUDFLARE_DIR/src"
cp -r "$APP_ROOT/build" "$CLOUDFLARE_DIR/build"
echo "contexto pronto em $CLOUDFLARE_DIR"
