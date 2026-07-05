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
npm run dev           # o app; no 1º boot o wizard pergunta o que faltar
```

No primeiro boot sem config completa, o **onboarding** abre e coleta credenciais
do Trello, o board, o mapeamento coluna→estado e o diretório base dos
repositórios — grava `task-sources.yaml` / `connector.yaml` / `.env` e segue.

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
