/**
 * Telegram alert channel (D22, F4 #186).
 *
 * The orchestrator's only "wake you up at 3am" signal: card blocked with a
 * `security*` blockReason, or the night-run itself failing/hard-stopping
 * with work interrupted. D22 rejected WhatsApp Cloud API (Meta-preapproved
 * templates) in favor of "1 token, 1 POST" — deliberately no queue/retry.
 * Everything else stays on the board/report, never here (10-ESTADOS-DAS-TAREFAS.md).
 */

export function isSecurityBlockReason(blockReason: string | undefined): boolean {
  return !!blockReason && blockReason.startsWith("security");
}

export async function sendTelegramAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ausentes — alerta não enviado:", text);
    return;
  }
  // ponytail: 1 POST, sem retry/fila — D22 pede "sendMessage único"; se falhar
  // (rede ou HTTP), só loga — o card 📊 07:30 ausente (09-RUNBOOK.md) é o
  // alarme de reserva. Nunca deixa o caller (blocked.ts/runNightCycle) explodir
  // por causa de um alerta que é conveniência, não caminho crítico.
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) console.error(`[telegram] sendMessage falhou (${res.status}):`, await res.text());
  } catch (err) {
    console.error("[telegram] sendMessage falhou:", err instanceof Error ? err.message : err);
  }
}
