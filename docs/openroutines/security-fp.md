# Falsos-positivos de segurança — openroutines

Living doc lido pela lente de segurança (F4 #154, `src/security/fp-file.ts#parseFalsePositives`).
Cada repo revisado mantém o seu em `docs/openroutines/security-fp.md`; arquivo ausente = lista vazia.

Formato da coluna "Padrão": `` `glob-do-arquivo` — "fragmento da regra/descrição" `` — o glob casa
com o `file` do achado (`*` dentro de um segmento, `**` qualquer profundidade) e o fragmento
entre aspas (opcional) precisa aparecer na descrição do achado. Achado que casa é marcado
falso-positivo na rodada de verificação, sem gastar refutação.

Só adicione uma linha aqui depois que um achado foi adjudicado como falso-positivo — este
arquivo suprime achados futuros equivalentes.

| Padrão (arquivo/regra) | Justificativa | Adicionado em |
|---|---|---|
| `src/webhooks/*.ts` — "missing rate limit" | Exemplo de formato (path não existe neste repo): rate limit já aplicado no proxy Tailscale | 2026-07-03 |
