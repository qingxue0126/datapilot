import type { RequestContext } from "../../shared/types/context.js";
import type { AnalysisMessage, SessionStore } from "./session-store.js";

export type ConversationTurn = {
  question: string;
  answer: string;
  createdAt: number;
};

export type ConversationContext = {
  turns: ConversationTurn[];
  availableTurns: number;
  truncated: boolean;
  droppedTurns: number;
};

export type ContextManagerOptions = {
  historyWindow?: number;
  maxCharacters?: number;
};

/**
 * Builds a bounded, chronological conversation view from persisted exchanges.
 * It deliberately does not infer intent, topics, references, or slots.
 */
export class ContextManager {
  private readonly historyWindow: number;
  private readonly maxCharacters: number;

  constructor(options: ContextManagerOptions = {}) {
    this.historyWindow = positiveInteger(options.historyWindow ?? Number(process.env.PHONE_SUPPORT_CONTEXT_TURNS), 10);
    this.maxCharacters = positiveInteger(options.maxCharacters ?? Number(process.env.PHONE_SUPPORT_CONTEXT_MAX_CHARS), 8_000);
  }

  fromSession(store: SessionStore, context: RequestContext, sessionId: string): ConversationContext {
    return this.organize(store.get(context, sessionId).messages);
  }

  organize(messages: AnalysisMessage[]): ConversationContext {
    const allTurns = toTurns(messages);
    const windowed = allTurns.slice(-this.historyWindow);
    let used = windowed;
    let characters = 0;
    for (let index = windowed.length - 1; index >= 0; index--) {
      const size = turnSize(windowed[index]);
      if (characters + size > this.maxCharacters && used.length > 1) {
        used = windowed.slice(index + 1);
        break;
      }
      characters += size;
    }
    const boundedTurns = used.length === 1 && turnSize(used[0]) > this.maxCharacters
      ? [truncateTurn(used[0], this.maxCharacters)]
      : used;
    return {
      turns: boundedTurns,
      availableTurns: allTurns.length,
      truncated: boundedTurns.length !== allTurns.length || boundedTurns[0] !== used[0],
      droppedTurns: allTurns.length - boundedTurns.length,
    };
  }
}

function toTurns(messages: AnalysisMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let pending: AnalysisMessage | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      pending = message;
      continue;
    }
    if (!pending) continue;
    turns.push({ question: pending.content, answer: message.content, createdAt: Date.parse(message.createdAt) || 0 });
    pending = undefined;
  }
  return turns;
}

function turnSize(turn: ConversationTurn) { return turn.question.length + turn.answer.length; }
function truncateTurn(turn: ConversationTurn, maxCharacters: number): ConversationTurn {
  const questionLength = Math.min(turn.question.length, Math.max(1, Math.floor(maxCharacters / 2)));
  const answerLength = Math.max(0, maxCharacters - questionLength);
  return { ...turn, question: turn.question.slice(-questionLength), answer: turn.answer.slice(-answerLength) };
}
function positiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
