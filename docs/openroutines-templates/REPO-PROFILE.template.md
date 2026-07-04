# Repo Profile — <nome do repo>
> Compilado em AAAA-MM-DD pelo OpenRoutines · revalidado a cada PR que move ponto de entrada

<!--
  Núcleo auditável (contrato de frescor, verificável mecanicamente): Tese de arquitetura,
  Stack resumida, Comandos canônicos, Arquivos-chave, Rotas douradas, Gotchas, Instruções
  para Agentes de IA, Slugs raizes-docs aplicáveis. As demais são "seção de contexto (pode
  defasar; código vence)" — geradas no mapeamento, atualizadas em best-effort.
-->

## Tese de arquitetura
**<uma frase em negrito que resume a decisão de design do produto>**
(ex.: "o WhatsApp é a UI primária; o dashboard é complemento; a landing é captação")

## O que é / quando mexer aqui
_seção de contexto (pode defasar; código vence)_

[Resumo: o que o repo faz, quando um card aponta para cá e quando NÃO aponta]

## Repos que compõem o produto
_seção de contexto (pode defasar; código vence)_

| Repo | Função |
|---|---|

## Stack resumida
[linguagem, framework+versão, ORM, filas, banco — o suficiente pra saber os comandos]

## Comandos canônicos
| Ação | Comando |
|---|---|
| install / build / test / lint / typecheck | ... |
| subir sandbox | docker compose -f compose.openroutines.yml up |
| seed | ... |

## Fluxo end-to-end
_seção de contexto (pode defasar; código vence)_

[passos numerados + diagrama mermaid do caminho crítico, incluindo o que só existe
 em runtime (debounces, buffers, webhooks)]

## Domínios de dados
_seção de contexto (pode defasar; código vence)_

[entidades principais + ONDE MORA A FONTE DE VERDADE do schema
 (ex.: "dashboard não tem migration própria; espelha via prisma db pull do agent")]

## Integrações
_seção de contexto (pode defasar; código vence)_

[pontos de contato numerados, cada um LINKANDO o slug do raizes-docs correspondente]

## Onde roda (deploy)
_seção de contexto (pode defasar; código vence)_

[plataforma, região, env vars esperadas, o que NUNCA fazer daqui (ex.: nunca aplicar
 migration em prod — CI/CD faz)]

## Público e produto
_seção de contexto (pode defasar; código vence)_

- **Quem usa:** [perfil real do usuário final]
- **Quem mexe no código:** [o que um agente precisa saber sobre o porquê das coisas]

## Identidade visual
_seção de contexto (pode defasar; código vence)_

[paleta/tokens (link @tree-ia-raizes/tokens se usa), tipografia, tom das telas,
 componentes-chave; referência às capturas em docs/visual/]

## Arquivos-chave
[paths reais → papel, 1 linha cada — corta a exploração]

## Rotas douradas
[as rotas/telas críticas do produto que a validação visual (fase 6) sempre re-checa por SSIM,
 além da rota tocada pelo card. Ex.: /pedidos, /pedidos/:id, /login. É a CASA ÚNICA dessa lista
 (o repo-registry repos.yaml não a duplica).]

## Exemplares (D31)
[5–8 SHAs de commits humanos bem-avaliados, um por change-shape (nova rota, novo service, nova
 tool de agente, migration, novo componente UI, novo teste). Minerados no Mapeamento via git log.
 O orquestrador casa o change-shape do PLAN.md e injeta `git show <sha>` (cap ~200 linhas) no
 prompt de implementação: "imite esta estrutura". LLM imita exemplo melhor do que segue regra.]

## Matriz de acesso (authz/tenant/RLS) · Invariantes de domínio · Golden queries
_seção de contexto (pode defasar; código vence)_

[insumos executáveis do verify (D30): principals de seed × rotas × resultado esperado; asserções
 SQL invariantes (ex.: SUM(ledger)=0); queries cujo plano (EXPLAIN) não pode regredir.]

## Gotchas
[comportamento não-óbvio que quebra silenciosamente]

## Instruções para Agentes de IA
1. **Fonte de verdade que vence:** [código+testes > schema > docs — especificar]
2. **O que implementar:** [convenções deste repo: onde nasce rota/service/tool]
3. **O que NÃO inferir:** [IDs opacos, tenant, nomes de fila, envs — lista explícita]
4. **Como validar:** [comandos exatos que provam que a mudança está boa]

## Slugs raizes-docs aplicáveis
[lista dos slugs que o orquestrador injeta no prompt de qualquer card deste repo]
