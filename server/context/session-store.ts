import type { ChatTurn, RequestContext } from "../core/types.js";

export interface SessionStore {
  history(context: RequestContext): ChatTurn[];
  append(context: RequestContext, turn: ChatTurn): void;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ChatTurn[]>();
  history(context: RequestContext) { return [...(this.sessions.get(this.key(context)) || [])]; }
  append(context: RequestContext, turn: ChatTurn) {
    const turns = [...this.history(context), turn].slice(-10);
    this.sessions.set(this.key(context), turns);
  }
  private key(context: RequestContext) { return `${context.tenantId}:${context.accountSetId}:${context.userId}:${context.sessionId}`; }
}
