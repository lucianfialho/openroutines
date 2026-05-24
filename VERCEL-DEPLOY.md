# Deploy na Vercel

Deploy serverless do OpenRoutines usando **Vercel Functions** + **Neon PostgreSQL**.

## O que muda vs. local/Tailscale

| Antes (Express) | Agora (Vercel) |
|---|---|
| Servidor Express contínuo | Vercel Serverless Functions |
| `node-cron` em background | Vercel Cron Jobs |
| PostgreSQL local/Render | Neon Serverless PostgreSQL |
| BullMQ + Redis | Execução síncrona direta (sem fila) |
| `main.ts` com `app.listen()` | `api/` com handlers serverless |

## Pré-requisitos

1. Conta na [Vercel](https://vercel.com)
2. Conta na [Neon](https://neon.tech) (free tier permanente)
3. CLI da Vercel instalada: `npm i -g vercel`
4. Repo `openroutines` no GitHub

## Passo a passo

### 1. Criar banco Neon

1. Acesse [neon.tech](https://neon.tech) → New Project
2. Copie a **connection string** (começa com `postgresql://...`)
3. Adicione `?sslmode=require` no final se não tiver

### 2. Configurar variáveis de ambiente na Vercel

No dashboard da Vercel (Project → Settings → Environment Variables):

```
DATABASE_URL=postgresql://user:pass@host.neon.tech/db?sslmode=require
KIMI_API_KEY=sk-...
GITHUB_TOKEN=ghp_...
GITHUB_REPO=lucianfialho/openroutines
GITHUB_WEBHOOK_SECRET=supersecreto123
ROUTINES_DIR=./routines
SKILLS_DIR=./.gates/skills
```

> **Dica:** Use `vercel env add DATABASE_URL` na CLI também.

### 3. Conectar repo e deploy

```bash
# Login na Vercel
vercel login

# Linkar projeto (ou criar novo)
vercel --prod
```

Ou via dashboard:
1. Vercel → Add New Project
2. Import `lucianfialho/openroutines`
3. Framework Preset: **Other**
4. Build Command: deixe em branco (Vercel detecta `api/`)
5. Deploy

### 4. Verificar endpoints

Após o deploy:

```bash
# Health check
curl https://<seu-projeto>.vercel.app/health

# Webhook (GitHub vai bater aqui)
curl -X POST https://<seu-projeto>.vercel.app/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issues" \
  -d '{"action":"opened"}'
```

### 5. Configurar webhook no GitHub

1. Repo → Settings → Webhooks → Add webhook
2. **Payload URL:** `https://<seu-projeto>.vercel.app/webhooks/github`
3. **Content type:** `application/json`
4. **Secret:** o mesmo valor de `GITHUB_WEBHOOK_SECRET`
5. **Events:** Issues

### 6. Gerar cron jobs (se adicionar novas routines)

Se criar/modificar routines com triggers `schedule`:

```bash
npm run vercel:generate
```

Isso atualiza o `vercel.json` com os cron jobs. Depois commite e push.

> **Nota:** A Vercel aplica os cron jobs automaticamente no próximo deploy.

## Estrutura de arquivos serverless

```
api/
├── webhooks/
│   └── github.ts      ← POST /webhooks/github
├── cron/
│   └── [routineId].ts ← GET /cron/:routineId
└── health.ts          ← GET /health
```

## Troubleshooting

### "Database connection failed"
- Verifique se `DATABASE_URL` está configurado na Vercel
- Certifique-se de que `?sslmode=require` está na connection string

### "Webhook signature invalid"
- Verifique se `GITHUB_WEBHOOK_SECRET` é idêntico no GitHub e na Vercel
- O secret não pode ter espaços extras

### Cron job não executa
- Verifique se o `vercel.json` tem a seção `crons`
- A Vercel só aplica cron jobs em deploys de produção (não preview)

## Custo

| Serviço | Tier | Custo |
|---|---|---|
| Vercel Functions | Hobby | **$0** (10s timeout, 1024MB RAM) |
| Neon Postgres | Free | **$0** (500MB storage, 190 compute hours) |
| **Total** | | **$0** |

> Para produção real (mais de 1 routine cron ou webhooks frequentes), avalie o plano Pro da Vercel ($20/mês) para aumentar timeout e concorrência.
