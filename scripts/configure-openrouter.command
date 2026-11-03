#!/bin/bash
set -euo pipefail

key_file="$HOME/Library/Application Support/org.opengrind.app/secrets/openrouter-api-key"
key_dir="$(dirname "$key_file")"

printf 'Cole sua chave da OpenRouter (a entrada ficará oculta): '
IFS= read -r -s api_key
printf '\n'

if [[ -z "$api_key" ]]; then
	echo "Nenhuma chave foi informada; nada foi alterado." >&2
	exit 1
fi

umask 077
mkdir -p "$key_dir"
chmod 700 "$key_dir"
printf '%s' "$api_key" > "$key_file"
chmod 600 "$key_file"
unset api_key

echo "Chave salva localmente com permissões privadas."
echo "Feche e abra o Open Grind para ativar a integração."
read -r -p "Pressione Enter para fechar..."
