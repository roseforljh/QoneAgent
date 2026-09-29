/** SDK event timings, not TCP timings. Never record prompts or response text. */
export class ModelResponseTiming {
  private startedAt?: number;
  private firstResponseAt?: number;
  private firstTextAt?: number;
  private textDeltas = 0;
  private reasoningDeltas = 0;

  record(type: string, payload: Record<string, unknown>, now = Date.now()) {
    if (type === "model.request.started") {
      this.startedAt = now;
      this.firstResponseAt = this.firstTextAt = undefined;
      this.textDeltas = this.reasoningDeltas = 0;
    }
    const role = (payload.message as { role?: string } | undefined)?.role;
    if (type === "message.started" && role === "assistant") this.firstResponseAt ??= now;
    if (type === "message.reasoning.delta") { this.firstResponseAt ??= now; this.reasoningDeltas++; }
    if (type === "message.delta" && payload.blockType !== "tool-call") {
      this.firstTextAt ??= now;
      this.firstResponseAt ??= now;
      this.textDeltas++;
    }
    if (type !== "message.completed" || role !== "assistant" || this.startedAt === undefined) return undefined;
    const result = {
      startedAt: this.startedAt, firstResponseAt: this.firstResponseAt,
      firstTextAt: this.firstTextAt, completedAt: now,
      textDeltas: this.textDeltas, reasoningDeltas: this.reasoningDeltas,
    };
    this.startedAt = undefined;
    return result;
  }
}
