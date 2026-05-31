# Diagnóstico & Roadmap: OpenRoutines Stabilization

> Data: 2026-05-31  
> Status: Dogfooding revelou fragilidade sistêmica  
> Recomendação: Arquitetura nova, não mais patches

---

## 1. Diagnóstico Honesto

### O que funciona (fundação)

| Componente | Status |
|-----------|--------|
| Tool Registry (read_file, edit_file, run_shell, git) | ✅ Funciona quando usado corretamente |
| Worktree creation + node_modules symlink | ✅ Funciona no container |
| Gate Engine (checkGate, approve, stateId) | ✅ Fixado e funcional |
| State Machine (execução linear, resume) | ✅ Fixado e funcional |
| Template Engine | ✅ Funciona |
| Output Extractor (JSON/YAML) | ✅ Funciona |
| PostgreSQL persistence | ✅ Funciona |
| BullMQ queue | ✅ Funciona |
| Auto-action (commit_and_push, create_pr) | ✅ Funciona quando LLM coopera |

### O que não funciona (orquestração)

| Problema | Impacto | Causa Raiz |
|----------|---------|-----------|
| LLM não passa `cwd` → lê repo principal em vez de worktree | 🔴 Crítico | Prompt não instrui explicitamente |
| Review entra em loop de `read_file` sem nunca emitir veredicto | 🔴 Crítico | Prompt longo demais, LLM se perde |
| Verify falha mas marca `completed` | 🔴 Crítico | Sem check de `tests_passed == false` |
| PR creation falha com `gh command failed` | 🔴 Crítico | Branch não existe no remote (worktree removido) |
| Execução em loop infinito em falhas | 🔴 Crítico | `currentState` no metadata não atualizado antes de executar estado |
| Agent resolve sintoma, não causa | 🟡 Alto | Prompt de review não exige root-cause check |
| Commits artefatos de ambiente | 🟡 Alto | Sem validação pré-commit |
| PR título/branch genéricos | 🟡 Alto | Hardcoded "feat: implement changes" |

### Taxa de sucesso real

- **1 PR gerado automaticamente** em 9+ execuções = **11%**
- A única que funcionou foi no início do projeto, antes dos bugs se acumularem
- Todas as execuções desde então falharam em algum ponto

---

## 2. Causa Raiz: Orquestração Determinística + LLM Probabilístico

O pipeline atual é uma **state machine linear rígida**:

```
fetch_issue → analyze → create_worktree → implement → review → verify → pr_gate → commit_and_push → create_pr → done
```

O LLM é **probabilístico e stateless**. Ele não "lembra" que está no meio de um pipeline. Cada chamada é independente. Quando o LLM:
- Esquece de passar `cwd`
- Entra em loop de `read_file` sem emitir veredicto
- Emite `verdict: approved` mesmo com `changes: []`

A state machine não tem como recuperar. Ela só pode:
1. Voltar para `implement` (review rejeita)
2. Falhar (max iterations)
3. Ou aceitar o output errado

Isso é arquitetural. Não é fixável com patches.

---

## 3. Proposta: Graph of Operations (GoO) como Orquestração

Inspirado em [Graph of Thoughts](https://github.com/spcl/graph-of-thoughts), mas adaptado para coding agents.

### Princípios

1. **Cada operação é idempotente e auto-contida** — se falha, pode ser re-executada
2. **Thoughts são imutáveis** — cada operação cria novos thoughts, não modifica os antigos
3. **Score é determinístico** — testes passam ou não; coverage é um número; não depende do LLM
4. **O grafo decide; o LLM executa** — o grafo define o que tentar, o LLM gera o código

### Grafo Proposto para "Solve Issue"

```
[Issue] → Generate(plan: 3 abordagens)
        → Score(cada plano: complexidade, risco)
        → KeepBestN(1)
        → Generate(implementação para o plano escolhido)
        → ValidateAndImprove(testes, max_tries=3)
        → GroundTruth(review humano opcional)
        → [PR]
```

### Operações

| Operação | Descrição | Exemplo no OpenRoutines |
|----------|-----------|------------------------|
| `Generate` | Cria N variações de código | 3 implementações diferentes |
| `Score` | Avalia objetivamente | Testes passam? Type check? Lint? |
| `Improve` | Refina uma implementação | Fixa erros de compilação |
| `Aggregate` | Combina o melhor de várias | Mescla funções de 2 implementações |
| `KeepBestN` | Mantém os top N | Só a implementação com 100% de testes |
| `ValidateAndImprove` | Testa, se falhar melhora (limite) | Roda `npm test`, se falhar pede fix |
| `GroundTruth` | Verificação humana | Gate de aprovação antes do PR |
| `Selector` | Filtra thoughts | Só thoughts com `tests_passed: true` |

### Por que isso resolve os problemas atuais

| Problema Atual | Como GoO resolve |
|----------------|-----------------|
| LLM esquece `cwd` | Cada operação recebe o contexto completo como input; não depende de memória do LLM |
| Loop infinito review→implement | `ValidateAndImprove` tem `max_tries` embutido; após 3 falhas, descarta o thought |
| Verify falha mas aceita | `Score` com `scoring_function` determinística; `tests_passed: false` = score 0 |
| Agent resolve sintoma | `Aggregate` + `KeepBestN` força explorar múltiplas abordagens |
| Commits artefatos | `ValidateAndImprove` inclui check de `git status` como validação |
| PR genérico | `GroundTruth` gate permite humano editar título/branch antes de merge |

---

## 4. Fundação Necessária (antes do GoO)

Antes de implementar GoO, a fundação precisa ser sólida:

### 4.1 Tool Execution Layer

```typescript
interface ToolExecutor {
  execute(tool: ToolDefinition, args: Record<string, unknown>): Promise<ToolResult>;
  // Idempotente — mesma input → mesma output
  // Isolado — não afeta o ambiente fora do worktree
  // Observável — logs, spans, métricas
}
```

### 4.2 Worktree Isolation

- Cada execução tem seu próprio worktree
- `node_modules` via symlink funcional
- `.gitignore` raiz correto (`node_modules` sem barra)
- Worktree persiste até o PR ser mergeado (não removido no meio)

### 4.3 State Persistence

- Snapshot completo do estado a cada operação
- Resume do snapshot, não do "estado atual"
- Idempotência: mesma operação 2x = mesmo resultado

### 4.4 Gate Engine

- Gate por operação (não por execução)
- Aprovação com contexto (o que está sendo aprovado?)
- Rejeição com feedback estruturado

---

## 5. Plano de Execução

### Fase 1: Fundação Sólida (2 semanas)

- [ ] Teste E2E passando (pipeline linear completo)
- [ ] Worktree persistente entre reinícios de container
- [ ] Verify falha → status `failed` (não `completed`)
- [ ] PR creation robusta (branch existe, gh autenticado)
- [ ] Sem loops infinitos (max retries por operação, não global)

### Fase 2: Instrumentação (1 semana)

- [ ] Score automático por operação (testes, lint, coverage)
- [ ] Observabilidade: cada operação gera span com input/output/score
- [ ] Dashboard: taxa de sucesso por operação, não só por execução

### Fase 3: Graph of Operations (2-3 semanas)

- [ ] Novo skill type: `graph-of-operations`
- [ ] YAML define grafo, não sequência
- [ ] Controller executa grafo em ordem topológica
- [ ] Cada operação é uma chamada de LLM + tool calls
- [ ] Thoughts persistidos entre operações

### Fase 4: Dogfooding GoO (contínuo)

- [ ] Migrar `solve-issue` de state machine para GoO
- [ ] A/B: GoO vs state machine na mesma issue
- [ ] Métrica: taxa de sucesso PR auto-gerado

---

## 6. Decisões Arquiteturais

### State Machine YAML → GoO YAML

**Hoje:**
```yaml
states:
  implement:
    agent_prompt: "Implement the fix..."
    tools: [read_file, edit_file, emit_output]
    transitions:
      - to: review
```

**Futuro:**
```yaml
operations:
  - id: generate_impl
    type: Generate
    num_branches: 3
    prompt: "Implement fix for {{issue.title}}"
    tools: [read_file, edit_file]

  - id: validate_impl
    type: ValidateAndImprove
    num_tries: 3
    validate_function: run_tests

  - id: keep_best
    type: KeepBestN
    n: 1
    scoring_function: test_coverage

  - id: human_gate
    type: GroundTruth
    gate: manual_approval
```

### Controller

```typescript
class GraphController {
  async run(graph: GraphOfOperations, initialState: Thought): Promise<Thought[]> {
    const queue = graph.roots;
    while (queue.length > 0) {
      const op = queue.shift()!;
      await op.execute(this.lm, this.toolRegistry);
      for (const succ of op.successors) {
        if (succ.predecessors.every(p => p.executed)) {
          queue.push(succ);
        }
      }
    }
    return graph.leaves.flatMap(l => l.getThoughts());
  }
}
```

---

## 7. Conclusão

O OpenRoutines tem uma **fundação boa** (tools, worktree, gates, persistence) mas uma **orquestração frágil** (state machine linear determinística tentando controlar um LLM probabilístico).

A solução não é mais patches no state machine. É uma **arquitetura nova** onde:
- O grafo decide o que tentar
- O LLM gera código, não controla o fluxo
- Cada operação é idempotente, observável e recoverable
- A fundação existente (tools, worktree, gates) é reutilizada sem mudanças

**Próximo passo:** Fase 1 — fazer o pipeline linear passar no teste E2E. Sem isso, não há fundação para construir o GoO.
