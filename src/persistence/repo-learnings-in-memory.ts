/**
 * In-Memory Repo Learnings Repository
 *
 * For testing and local development. Not for production use. Mirrors the
 * postgres repo's dedupe key: lowercase+trim of `fato`, no embeddings.
 */
import type { RepoLearning, RepoLearningRepository } from "./types.js";

const normalize = (fato: string): string => fato.trim().toLowerCase();

export const makeInMemoryRepoLearningRepository = (): RepoLearningRepository => {
  const store: RepoLearning[] = [];

  return {
    upsertByFato: async (repo, input) => {
      const key = normalize(input.fato);
      const existing = store.find((l) => l.repo === repo && normalize(l.fato) === key);
      if (existing) {
        existing.freq += 1;
        existing.vistoEm.push(new Date());
        existing.evidencia = input.evidencia ?? existing.evidencia;
        existing.escopo = input.escopo ?? existing.escopo;
        return;
      }
      store.push({
        id: crypto.randomUUID(),
        repo,
        fato: input.fato,
        evidencia: input.evidencia,
        escopo: input.escopo,
        vistoEm: [new Date()],
        freq: 1,
        promotedToProfile: false,
      });
    },
    findTopByRepo: async (repo, n) =>
      [...store]
        .filter((l) => l.repo === repo)
        .sort((a, b) => b.freq - a.freq)
        .slice(0, n),
    findPromotable: async () => store.filter((l) => l.freq >= 3 && !l.promotedToProfile),
    markPromoted: async (id) => {
      const learning = store.find((l) => l.id === id);
      if (learning) learning.promotedToProfile = true;
    },
  };
};
