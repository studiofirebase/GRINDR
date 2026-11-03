# Deploy na VM OCI existente

O Compose usa a imagem pré-compilada `open-grind-web:deploy`; carregue a imagem na VM antes de iniciar os serviços. A aplicação só fica acessível pela rede privada do Compose. Não publique portas do app no host.

O túnel existente `open-grind-meuprofile` é gerenciado localmente. A configuração em `cloudflared-config.yml` encaminha `meuprofile.com` para `app:8787` e exige que `cloudflared` valide o JWT do Access antes de encaminhar a requisição. O arquivo de credenciais do túnel deve ficar fora do repositório, por exemplo em `/etc/open-grind/tunnel-credentials.json`. A imagem `cloudflare/cloudflared:2026.10.0` roda como UID/GID `65532`; dê a esse usuário leitura exclusiva do arquivo (`0400`) e acesso de travessia à pasta, sem torná-lo legível por todos.

Configure `.env` a partir de `env.example` e ajuste `OG_TUNNEL_CREDENTIALS_FILE` para o caminho do arquivo instalado. `OG_ACCESS_EMAIL` deve corresponder ao e-mail permitido na política Cloudflare Access. Quando essa variável estiver configurada, o acesso administrativo usa essa identidade e não requer senha local.

Para iniciar ou atualizar sem compilar na VM:

```sh
docker compose up -d
```

O serviço `tunnel` precisa conseguir ler o arquivo de credenciais montado em `/etc/cloudflared/credentials.json`. A configuração do túnel não abre portas de entrada no host.
