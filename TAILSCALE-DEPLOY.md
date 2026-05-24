# Deploy no lucian-desktop via Tailscale

## 1. No lucian-desktop (Linux)

```bash
# Clone o repo
git clone https://github.com/lucianfialho/openroutines.git
cd openroutines

# Instala dependências
npm install

# Copia e edita env
cp .env.example .env
nano .env
```

Edite `.env`:
```
KIMI_API_KEY=sk-sua-key-da-moonshot
GITHUB_TOKEN=ghp-seu-token
GITHUB_REPO=lucianfialho/openroutines
GITHUB_WEBHOOK_SECRET=qualquer-string-secreta-aqui
PORT=3000
```

## 2. Expose via Tailscale

```bash
# Opção A: tailscale serve (recomendado, HTTPS automático)
tailscale serve --bg --https=443 localhost:3000

# Opção B: tailscale funnel (exposto na internet, não só Tailnet)
tailscale funnel --bg 3000

# Verifica seu hostname
tailscale status
# Ex: lucian-desktop.tailnet-name.ts.net
```

## 3. Configurar webhook no GitHub

Vai em https://github.com/lucianfialho/openroutines/settings/hooks

- **Payload URL**: `https://lucian-desktop.seu-tailnet.ts.net/webhooks/github`
- **Content type**: `application/json`
- **Secret**: mesma string do `GITHUB_WEBHOOK_SECRET`
- **Events**: Issues, Pull requests
- ✅ Active

## 4. Rodar

```bash
npx tsx src/main.ts
```

Você deve ver:
```
OpenRoutines ready on http://localhost:3000
Webhook: http://localhost:3000/webhooks/github
```

## 5. Testar

Abra um issue no repo `lucianfialho/openroutines`. O webhook vai:
1. Enviar POST para seu lucian-desktop
2. Engine vai carregar a rotina `issue-to-pr`
3. Provider (Kimi) vai gerar código
4. Connector (gh) vai criar um PR

## Troubleshooting

### Webhook não chega
```bash
# Verifica se tailscale serve está ativo
tailscale serve status

# Testa localmente
curl http://localhost:3000/health

# Testa via Tailscale
curl https://lucian-desktop.seu-tailnet.ts.net/health
```

### Kimi não responde
- Verifique `KIMI_API_KEY` no `.env`
- Teste: `curl https://api.moonshot.cn/v1/models -H "Authorization: Bearer $KIMI_API_KEY"`

### GitHub CLI falha
- Verifique `GITHUB_TOKEN` no `.env`
- Teste: `GH_TOKEN=seu-token gh issue list --repo lucianfialho/openroutines`
