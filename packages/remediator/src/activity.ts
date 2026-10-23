/** Safe, bounded progress events for the local incident dashboard. */
export interface RemediationActivity {
  at: string;
  phase: 'sandbox' | 'checkout' | 'setup' | 'reproduction' | 'agent' | 'verification' | 'patch';
  kind: 'stage' | 'tool' | 'message' | 'usage' | 'status';
  message: string;
}

const MAX_LINE = 128_000;
const MAX_TEXT = 8_000;
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/;

/** Parses Supercharge `streaming-json` NDJSON without exposing thoughts or raw tool I/O. */
export function createAgentActivityParser(
  emit: (kind: RemediationActivity['kind'], message: string) => void,
  sanitize: (text: string) => string,
) {
  let pending = '';
  let text = '';
  const tools = new Map<string, string>();
  let toolCalls = 0;

  function flushText() {
    if (text.trim()) emit('message', sanitize(text.trim()).slice(0, 1000));
    text = '';
  }

  function line(raw: string) {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch { return; }
    switch (event.type) {
      case 'text':
        if (typeof event.data === 'string') text = (text + event.data).slice(0, MAX_TEXT);
        break;
      case 'tool_call': {
        flushText();
        const name = typeof event.toolName === 'string' && TOOL_NAME.test(event.toolName) ? event.toolName : 'tool';
        if (typeof event.toolCallId === 'string') tools.set(event.toolCallId, name);
        toolCalls++;
        emit('tool', `Running ${name}`);
        break;
      }
      case 'tool_call_update': {
        const name = typeof event.toolCallId === 'string' ? tools.get(event.toolCallId) : undefined;
        if (name && (event.status === 'completed' || event.status === 'failed')) {
          emit('tool', `${name} ${event.status}`);
          tools.delete(event.toolCallId as string);
        }
        break;
      }
      case 'usage': {
        flushText();
        const usage = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : null;
        const input = usage?.input_tokens;
        const output = usage?.output_tokens;
        if (Number.isSafeInteger(input) && Number.isSafeInteger(output)) emit('usage', `${input} input / ${output} output tokens`);
        break;
      }
      case 'end':
        flushText();
        emit('status', `Agent finished after ${toolCalls} tool calls`);
        break;
      case 'error':
        flushText();
        emit('status', 'Agent reported an error; see the incident outcome');
        break;
      // In particular, never forward thought, rawInput, rawOutput, or arbitrary data.
    }
  }

  return {
    push(chunk: string) {
      pending += chunk;
      if (pending.length > MAX_LINE) {
        pending = '';
        emit('status', 'Skipped an oversized agent event');
        return;
      }
      let breakAt = pending.indexOf('\n');
      while (breakAt >= 0) {
        const next = pending.slice(0, breakAt).trim();
        pending = pending.slice(breakAt + 1);
        if (next) line(next);
        breakAt = pending.indexOf('\n');
      }
    },
    finish() {
      if (pending.trim()) line(pending.trim());
      flushText();
      pending = '';
    },
    get toolCalls() { return toolCalls; },
  };
}
