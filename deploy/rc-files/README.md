# rc-files/ — hardening da conta de serviço `openroutines`

Fonte: `.openroutines/04-INFRA-MAQUINA.md` ("Hardening da conta de serviço") e
`.openroutines/05-GUARDRAILS-SEGURANCA.md` (Camada 4, "Defesa de host").

Por quê: a sessão Bash do Claude Code carrega os rc files da shell a cada invocação.
Se ficassem editáveis, um agente (via `Write`/`Edit`) — ou um card malicioso via prompt
injection — poderia plantar um comando nesses arquivos que roda em TODA chamada
subsequente, contornando os hooks/allowlist da Camada 4 (que só interceptam a chamada
de ferramenta em si, não o que o shell carrega antes de executá-la). Por isso os
arquivos são vazios **e** imutáveis: nem o próprio dono do processo consegue escrever
neles depois de instalados.

## Ownership e modo

| Path (na máquina alvo) | Owner:Group | Modo | Fonte |
|---|---|---|---|
| `~openroutines/.bashrc` | `root:root` | `0444` | `deploy/rc-files/.bashrc` |
| `~openroutines/.zshrc` | `root:root` | `0444` | `deploy/rc-files/.zshrc` |
| `~openroutines/.profile` | `root:root` | `0444` | `deploy/rc-files/.profile` |
| `~openroutines/.bash_profile` | `root:root` | `0444` | `deploy/rc-files/.bash_profile` |
| `/etc/openroutines/env` | `root:openroutines` | `0640` | (gerado no bootstrap, não neste repo) |

`/etc/openroutines/env` **não** é root:root porque o processo do serviço (rodando como
`openroutines`, via `EnvironmentFile=` no systemd unit) precisa conseguir LER o arquivo;
o grupo `openroutines` dá essa leitura sem dar escrita a mais ninguém, e sem torná-lo
world-readable (secrets: `GITHUB_TOKEN`, `MOONSHOT_API_KEY`, `TRELLO_API_KEY`/`TOKEN`,
`DATABASE_URL`, etc. -- ver inventário completo em `04-INFRA-MAQUINA.md`).

## Install

```bash
sudo install -o root -g root -m 0444 deploy/rc-files/.bashrc        /home/openroutines/.bashrc
sudo install -o root -g root -m 0444 deploy/rc-files/.zshrc         /home/openroutines/.zshrc
sudo install -o root -g root -m 0444 deploy/rc-files/.profile       /home/openroutines/.profile
sudo install -o root -g root -m 0444 deploy/rc-files/.bash_profile  /home/openroutines/.bash_profile

# /etc/openroutines/env é criado/editado manualmente com os secrets reais (ver
# .openroutines/09-RUNBOOK.md, "Rotação de secrets") -- este repo não gera esse arquivo.
sudo install -o root -g openroutines -m 0640 /dev/null /etc/openroutines/env
```
