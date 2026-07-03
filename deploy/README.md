# deploy/ — artefatos de bootstrap (F3 Wave E, issue #152)

Estes arquivos são o *conteúdo* a instalar na máquina alvo (Ubuntu Server, ver
`04-INFRA-MAQUINA.md`). Nada aqui é executado por este repo — é copiado/instalado
manualmente (ou por um script de bootstrap futuro) nos caminhos abaixo.

`managed-settings.json` é JSON estrito (precisa passar `json.load` sem erro), então a
documentação de destino/ownership fica aqui fora, não como comentário dentro do arquivo.

| Arquivo | Instalar em | Owner:Group | Modo |
|---|---|---|---|
| `managed-settings.json` | `/etc/claude-code/managed-settings.json` | `root:root` | `0644` |
| `openroutines.service` | `/etc/systemd/system/openroutines.service` | `root:root` | `0644` |
| `claude-plugin/` | não copiar — carregar direto via `claude --plugin-dir /caminho/do/repo/deploy/claude-plugin` (ver `.openroutines/05-GUARDRAILS-SEGURANCA.md`, "Validador como plugin") | — | — |
| `rc-files/*` | `~openroutines/.bashrc` etc. — ver `rc-files/README.md` | `root:root` | `0444` |

## Conteúdo (fonte da verdade)

- `managed-settings.json`: cópia EXATA da Camada 3 de `.openroutines/05-GUARDRAILS-SEGURANCA.md`
  (não editar os valores aqui sem editar o doc primeiro — este arquivo é o que a revisão audita).
  Inclui o placeholder literal `<host-do-raizes-docs>` em `sandbox.network.allowedDomains` — o
  próprio 05 não resolve esse hostname; substituir pelo host real do serviço `raizes-docs` antes
  de instalar em produção (ver `openDecisions` do card #152).
- `claude-plugin/hooks/safety-check.py` + `hooks.json`: Camada 4 (hooks ALLOWLIST, não denylist).
- `openroutines.service`: unit systemd descrita em `04-INFRA-MAQUINA.md` ("Serviços (systemd)").

## Deploy manual (resumo)

```bash
sudo install -o root -g root -m 0644 deploy/managed-settings.json /etc/claude-code/managed-settings.json
sudo install -o root -g root -m 0644 deploy/openroutines.service /etc/systemd/system/openroutines.service
sudo systemctl daemon-reload
# hooks: sem cópia, aponta pro checkout do repo
claude --plugin-dir "$(pwd)/deploy/claude-plugin" ...
```
