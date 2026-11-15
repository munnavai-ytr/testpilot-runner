import { getSupabase } from './supabase';
import { redactSecrets } from './config';
import type { BugSeverity } from './types';

export interface ChatMessage {
  id: string;
  ts: string;
  type: 'ai' | 'finding' | 'system' | 'summary';
  caption?: string;
  text: string;
  stepIndex?: number;
  screenshot?: string | null;
  severity?: BugSeverity;
  state?: 'running' | 'done' | 'failed';
}

export type NewChatMessage = Omit<ChatMessage, 'id' | 'ts'>;

/**
 * Keeps the chat conversation of one run and writes it to Supabase.
 * Writes never block the test: they are batched and failures are only logged.
 */
export class ChatLog {
  private runId: string;
  private budgetMax: number;
  private messages: ChatMessage[] = [];
  private counter = 0;
  private liveStatus: string | null = null;
  private budgetUsed = 0;
  private dirty = { messages: false, status: false, budget: false };
  private running: Promise<void> | null = null;

  constructor(runId: string, budgetMax: number) {
    this.runId = runId;
    this.budgetMax = budgetMax;
  }

  public setStatus(text: string | null): void {
    this.liveStatus = text ? text.slice(0, 120) : null;
    this.dirty.status = true;
    this.kick();
  }

  public addMessage(msg: NewChatMessage): ChatMessage {
    const full: ChatMessage = {
      ...msg,
      id: `m${++this.counter}`,
      ts: new Date().toISOString(),
      caption: msg.caption ? msg.caption.slice(0, 80) : undefined,
      text: String(msg.text || '').slice(0, 800),
    };
    this.messages.push(full);
    this.dirty.messages = true;
    this.kick();
    return full;
  }

  public updateMessage(id: string, patch: Partial<NewChatMessage>): void {
    const target = this.messages.find((m) => m.id === id);
    if (!target) return;
    Object.assign(target, patch);
    this.dirty.messages = true;
    this.kick();
  }

  public countRequest(n = 1): void {
    this.budgetUsed += n;
    this.dirty.budget = true;
    this.kick();
  }

  public async flush(): Promise<void> {
    this.kick();
    while (this.running) {
      await this.running;
    }
  }

  private isDirty(): boolean {
    return this.dirty.messages || this.dirty.status || this.dirty.budget;
  }

  private kick(): void {
    if (this.running || !this.isDirty()) return;
    this.running = this.loop().finally(() => {
      this.running = null;
      if (this.isDirty()) this.kick();
    });
  }

  private async loop(): Promise<void> {
    while (this.isDirty()) {
      const payload: Record<string, unknown> = {};
      if (this.dirty.messages) payload.messages = this.messages;
      if (this.dirty.status) payload.live_status = this.liveStatus;
      if (this.dirty.budget) {
        payload.budget_used = this.budgetUsed;
        payload.budget_max = this.budgetMax;
      }
      this.dirty = { messages: false, status: false, budget: false };

      try {
        const sb = getSupabase();
        if (!sb) return;
        const { error } = await sb.from('runs').update(payload).eq('id', this.runId);
        if (error) console.error('[Chat] write failed:', redactSecrets(error.message));
      } catch (e) {
        console.error('[Chat] write error:', redactSecrets(String(e)));
      }
    }
  }
}
