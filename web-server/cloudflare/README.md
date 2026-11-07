# Deploy do web-server no Cloudflare Containers + meuprofile.com

Arquivos gerados pelo deploy (`Cargo.toml`, `Cargo.lock`, `src/`, `build/`
copiados para ca) sao ignorados pelo git; so os arquivos de config acima
destes fazem parte do repositorio.

## Uso

```sh
cd open-grind-host-src/web-server/cloudflare

# 1. Frontend atualizado (na raiz do app). OPEN_GRIND_WEB=1 e obrigatorio:
# sem ele o bridge web (`installWebBridge`) nao instala e a primeira pagina
# quebra com "Cannot read properties of undefined (reading 'transformCallback')".
cd ../.. && OPEN_GRIND_WEB=1 bun run build && cd web-server/cloudflare

# 2. Dependencias do Worker
bun install

# 3. Copia o crate Rust + frontend para o contexto do Docker
./prep.sh

# 4. Senha do admin (modo login por senha; sem dependencia do Access)
echo "<senha-8+-chars>" | npx wrangler secret put OG_PASSWORD

# 4b. Chave da IA (opcional; sem ela o chatbot/respostas ficam desligados)
# Pegue a sua em https://openrouter.ai/keys e rode:
npx wrangler secret put OPENROUTER_API_KEY
# Digite a chave no prompt do Wrangler; nao a coloque no comando/historico.
# O proximo request reinicia o container uma vez para carregar a chave.
# Isso apaga o /data efemero e exige novo login nos perfis Grindr.

# 5. Deploy (sobe Worker, builda/puxa a imagem amd64, liga meuprofile.com)
npx wrangler deploy
```

## Notas

- O disco do container (`/data`) e efemero: perfis e sessoes se perdem se a
  instancia parar. Para persistencia real, migrar para R2/D1 no futuro.
- O Worker compara um SHA-256 da chave, nunca armazena a chave no Durable
  Object, e reinicia o container quando ela e adicionada, removida ou trocada.
- O Worker usa instancia unica (`singleton`) porque o estado e local.
- `OG_ORIGIN` precisa continuar `https://meuprofile.com` para o login web.
