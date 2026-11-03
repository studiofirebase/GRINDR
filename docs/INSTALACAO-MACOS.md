# Instalação do Grindr Modificado V1 no macOS

1. Abra o arquivo `.dmg`.
2. Arraste `Grindr Modificado V1.app` para `Applications`.
3. Abra `Configurar OpenRouter.command` e informe sua própria chave da OpenRouter. A entrada fica oculta e a chave é salva somente no seu Mac, com acesso restrito à sua conta.
4. Abra o app e entre na sua conta Grindr.

A integração de respostas com IA usa a OpenRouter e precisa de uma chave válida e de créditos disponíveis na conta OpenRouter. A chave não é incluída no instalador. Para substituir ou configurar a chave depois, execute novamente `Configurar OpenRouter.command`; reinicie o Open Grind depois de alterar a chave.

Se o app ainda não tiver assinatura válida, o empacotamento aplica uma assinatura ad hoc. Isso não substitui uma assinatura Apple Developer ID nem a notarização: para distribuição externa sem avisos do Gatekeeper, assine e notarize o app antes de gerar o DMG.

## Gerar o instalador

Em um Mac, a partir da raiz do repositório:

```bash
nix run .#build-macos
bun run package:macos:dmg
```

O DMG será gravado em `src-tauri/target/release/artifacts/`. O segundo comando empacota o `.app` de release já gerado; para empacotar outro app, defina `APP_PATH` com o caminho completo para `Open Grind.app`.
