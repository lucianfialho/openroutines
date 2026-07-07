# Rodar o OpenRoutines localmente

Modo padrão: **infra em Docker, app na máquina.** O app roda na sua máquina (não
em container) para alcançar seus repositórios em `REPOS_BASE_DIR` e os CLIs
`claude`/`kimi` que você já logou — nada disso existe dentro de um container.

## Pré-requisitos (uma vez)

- Node 20+ e Docker.
- `claude setup-token` (login por assinatura, uso headless) e login do Kimi CLI.
- `gh auth login` (clone e PR autenticados via `gh`).

## Subir

```bash
npm install
npm run local:db     # Postgres + Redis em Docker (localhost:5432 / :6379)
cp .env.example .env  # já aponta DATABASE_URL/REDIS_URL para o Docker local
```

No `.env`, preencha pelo menos:

- `GITHUB_TOKEN` — fine-grained PAT com `contents:rw` + `pull_requests:rw` (e
  `Administration:read` se o repo tiver branch protection) cobrindo os repos
  que o sistema vai tocar.
- `OPENROUTINES_API_TOKEN` — um segredo que você escolhe; protege as rotas de
  mutação (`/trigger`, `/gates/*`...).
- `CLAUDE_CODE_OAUTH_TOKEN` — rode `claude setup-token`, cole o token impresso.
  É o que deixa a triagem e a execução noturna (Sonnet via CLI) rodarem
  headless pela sua assinatura, sem virar API key faturada.

Trello (`TRELLO_API_KEY`/`TRELLO_API_TOKEN`) pode ficar em branco — o wizard
abaixo pergunta.

```bash
npm run dev           # o app; no 1º boot o wizard pergunta o que faltar
```

No primeiro boot sem config completa, o **onboarding** abre e coleta credenciais
do Trello, o board, o mapeamento coluna→estado e o diretório base dos
repositórios, gravando `task-sources.yaml` / `connector.yaml` / `.env`. A partir
daí, todo boot garante (idempotente) que as colunas dedicadas
(`OpenRoutines — Fila`/`Working`) e a label `OpenRoutines` existam no board —
criando o que faltar.

## O card mínimo

Um card só precisa de:

- **Título e descrição** — o conceito da tarefa.
- **Uma label de projeto** identificando o repositório (ex. `Detect Water` —
  aliases em `repos.yaml` → `repos.<repo>.labels:`).

Uma linha `## Repositório` na descrição é **opcional** e, quando presente,
**vence a label**. Card sem repositório identificável (nem campo, nem label)
nunca fica em silêncio: a triagem comenta o motivo e move pra `Blocked`.

**Mover o card para `OpenRoutines — Fila` é o gatilho.** A label de flag
`OpenRoutines` não é mais exigida nas duas colunas dedicadas (Fila/Working) —
ela só distingue os cards do sistema nas colunas compartilhadas com o time
(Backlog/Blocked/Review/Done).

## O que acontece depois de mover o card

1. **Triagem** (cron a cada 30min, 8h–23h): um LLM (Sonnet, via CLI logado)
   lê o card e comenta `🤖 [Triagem]` com repositório, tipo, complexidade,
   interpretação, critérios de aceite e perguntas em aberto — preenchendo os
   custom fields `Complexidade`/`Prioridade` que estiverem em branco (valor
   humano sempre vence). Card pronto fica na Fila esperando a noite; card com
   pendência vai pra `Blocked` com instruções (ajuste a descrição/labels e
   volte pra Fila, ou responda com um comentário `🧭`).
2. **Execução noturna** (01:00, `night-run`): pega os cards prontos e, por
   tipo, abre PR de implementação (`card-to-pr`), parecer/issues de pesquisa
   (`card-research`) ou PR de `REPO-PROFILE.md` (`card-mapping`).
3. Comentários do agente são sempre pt-BR e prefixados (`🤖 [Triagem]`,
   `🛠️ [Execução]`, `⛔ [Bloqueio]`, `👀 [Handoff]`...) pro board continuar
   legível.

## Labels e campos

| O quê | Onde mora | Efeito |
|---|---|---|
| (sem label) | tipo do card | Implementação — vira PR de código |
| `OpenRoutines: Pesquisa` / `Mapeamento` | tipo do card | Mudam o pipeline (card-research / card-mapping); `Update` é rótulo informativo e roda o pipeline padrão (card-to-pr) |
| label de projeto (ex. `Detect Water`) | `repos.yaml` → `labels:` do repo | Resolve o repositório quando o card não tem `## Repositório` |
| `Complexidade` / `Prioridade` | custom fields do board | A triagem preenche o que estiver em branco; roteiam modelo/prioridade da fila noturna |

As labels de tipo (linha acima), as colunas dedicadas e a label `OpenRoutines`
são criadas idempotentemente pela validação de board a cada boot (seção
"Subir"); `npm run setup:trello-board` faz o mesmo provisionamento sem subir o
app (útil antes da primeira execução). Os custom
fields `Complexidade`/`Prioridade` precisam já existir no board (Trello →
Power-Ups → Custom Fields); nada disso os cria automaticamente.

Limites operacionais (orçamento de LLM por noite/dia, teto de PRs por noite,
PRs abertos por repo) ficam em `policy.yaml` (`night.budget_usd`,
`day.budget_usd`, `night.max_prs_per_night`,
`backpressure.max_open_prs_per_repo`...), não em env var.

## Repositórios

Ponha (ou clone) seus repos sob `REPOS_BASE_DIR` (ex. `/Volumes/programacao`). O
sistema resolve cada card pelo **nome** do repo (`REPOS_BASE_DIR/<nome>`) e
auto-descobre `githubRepo` / base branch / comandos de verify. Um card que nomeia
um repo ainda não clonado é clonado sozinho (`gh repo clone`), desde que o owner
esteja em `ALLOWED_REPO_OWNERS` e o `GITHUB_TOKEN` o alcance.

## Providers

Tudo roda pelos CLIs logados — **nenhuma API key é obrigatória**. `KIMI_API_KEY`
e `ANTHROPIC_API_KEY` são upgrades opt-in (ver `.env.example`).

## Ciclo noturno

```bash
curl -X POST http://localhost:3000/trigger/night-run \
  -H "Authorization: Bearer $OPENROUTINES_API_TOKEN"
```

Precisa de `DATABASE_URL` (Postgres local), `GITHUB_TOKEN` e ao menos um repo
resolvível. Parar a infra: `npm run local:down`.

## Serverless (opcional)

O caminho Vercel + Neon continua funcionando (`VERCEL-DEPLOY.md`) — o modo local
não removeu nada, só deixou de ser o default.
