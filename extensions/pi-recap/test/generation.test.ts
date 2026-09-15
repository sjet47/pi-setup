import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ agentDir: '' }));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => fixture.agentDir,
  buildSessionContext: (entries: any[]) => ({ messages: entries.filter(e => e.type === 'message').map(e => e.message) }),
  convertToLlm: (messages: unknown[]) => messages,
  serializeConversation: (messages: unknown[]) => JSON.stringify(messages),
}));

let recap: typeof import('../src/index').default;
beforeAll(async () => {
  fixture.agentDir = mkdtempSync(join(tmpdir(), 'pi-recap-test-'));
  mkdirSync(join(fixture.agentDir, 'extensions'));
  writeFileSync(join(fixture.agentDir, 'extensions/pi-recap.json'), JSON.stringify({ model: 'test/thinking-model' }));
  recap = (await import('../src/index')).default;
});
afterAll(() => rmSync(fixture.agentDir, { recursive: true, force: true }));

async function setup(complete: (...args: any[]) => Promise<any>) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const entries = [{ type: 'message', id: 'user1', message: { role: 'user', content: 'Fix recap generation.' } }];
  const saved: any[] = [];
  const notifications: string[] = [];
  const widgets = new Map<string, unknown>();
  const ctx = {
    hasUI: false,
    sessionManager: {
      getBranch: () => entries, getEntries: () => entries, getLeafId: () => 'user1',
      buildSessionContext: () => ({ messages: entries.map(e => e.message) }),
    },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
      getProviderAuth: async () => ({ auth: { apiKey: 'test-only' } }),
      complete,
    },
    ui: {
      setWidget: (key: string, value: unknown) => widgets.set(key, value),
      notify: (message: string) => notifications.push(message),
    },
  };
  recap({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    appendEntry: (type: string, data: unknown) => saved.push({ type, data }),
  } as any);
  await handlers.get('session_start')!({}, ctx);
  ctx.hasUI = true;
  return { ctx, saved, notifications, widgets, handlers, run: () => commands.get('recap').handler('', ctx) };
}

const textResponse = { stopReason: 'stop', content: [{ type: 'text', text: '修复摘要生成；下一步重载扩展。' }] };

describe('recap generation', () => {
  test('leaves room for reasoning before generating the visible recap', async () => {
    // A reasoning provider spends 512 tokens before producing its 80-token answer.
    const f = await setup(async (_model, _context, options) => options.maxTokens < 592
      ? { stopReason: 'length', content: [{ type: 'thinking', thinking: 'Working...' }] }
      : textResponse);
    await f.run();
    expect(f.notifications).toEqual([]);
    expect(f.saved[0]).toEqual({ type: 'pi-recap:state', data: { version: 2, lastRecap: textResponse.content[0].text, contextLeafId: 'user1' } });
  });

  test('allows requests that take more than four seconds', async () => {
    const f = await setup(async (_model, _context, options) => options.timeoutMs < 6000
      ? { stopReason: 'error', errorMessage: 'Request timed out.', content: [] }
      : textResponse);
    await f.run();
    expect(f.notifications).toEqual([]);
    expect(f.saved).toHaveLength(1);
  });

  test('explains reasoning/output exhaustion instead of reporting a generic failure', async () => {
    const f = await setup(async () => ({ stopReason: 'length', content: [{ type: 'thinking', thinking: 'Still thinking' }] }));
    await f.run();
    expect(f.notifications[0]).toMatch(/output token limit reached.*including reasoning/);
    expect(f.saved).toEqual([]);
    expect(f.widgets.get('pi-recap')).toBeUndefined();
  });

  test('shows a bounded, terminal-safe provider error', async () => {
    const f = await setup(async () => ({ stopReason: 'error', errorMessage: '\x1b[31m429 rate limit\x1b[0m\n' + 'x'.repeat(1000), content: [] }));
    await f.run();
    expect(f.notifications[0]).toContain('429 rate limit');
    expect(f.notifications[0]).not.toMatch(/[\x1b\n]/);
    expect(f.notifications[0].length).toBeLessThan(300);
  });

  test('shows thrown request failures', async () => {
    const f = await setup(async () => { throw new Error('Connection timed out'); });
    await f.run();
    expect(f.notifications).toEqual(['Recap generation failed: Connection timed out']);
  });

  test('a superseded manual request cannot clear the newer result', async () => {
    let rejectRequest!: (error: Error) => void;
    let started!: () => void;
    let calls = 0;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const f = await setup(async () => {
      if (++calls > 1) return textResponse;
      started();
      return new Promise((_resolve, reject) => { rejectRequest = reject; });
    });
    const first = f.run();
    await requestStarted;
    await f.run();
    const newerWidget = f.widgets.get('pi-recap');
    rejectRequest(new Error('Request aborted'));
    await first;
    expect(f.notifications).toEqual([]);
    expect(f.saved).toHaveLength(1);
    expect(f.widgets.get('pi-recap')).toBe(newerWidget);
  });

  test('an aborted old request cannot clear a newer recap widget or report failure', async () => {
    let rejectRequest!: (error: Error) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const f = await setup(async () => {
      started();
      return new Promise((_resolve, reject) => { rejectRequest = reject; });
    });
    const pending = f.run();
    await requestStarted;
    await f.handlers.get('agent_start')!({}, f.ctx);
    const newerWidget = () => 'new recap';
    f.widgets.set('pi-recap', newerWidget);
    rejectRequest(new Error('Request aborted'));
    await pending;
    expect(f.notifications).toEqual([]);
    expect(f.widgets.get('pi-recap')).toBe(newerWidget);
    expect(f.saved).toEqual([]);
  });
});
