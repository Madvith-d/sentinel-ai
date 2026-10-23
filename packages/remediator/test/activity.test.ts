import { expect, test } from 'bun:test';
import { createAgentActivityParser } from '../src/activity.ts';

test('streams only tool names and completed assistant text, never thoughts or raw tool I/O', () => {
  const messages: string[] = [];
  const parser = createAgentActivityParser((kind, message) => messages.push(`${kind}:${message}`),
    (text) => text.replaceAll('dedicated-secret', '[REDACTED]'));
  parser.push('{"type":"thought","data":"private reasoning"}\n{"type":"text","data":"I found the ded');
  parser.push('icated-secret"}\n{"type":"tool_call","toolCallId":"1","toolName":"read_file","rawInput":{"secret":"do-not-show"}}\n');
  parser.push('{"type":"tool_call_update","toolCallId":"1","status":"completed","rawOutput":{"secret":"hidden"}}\n');
  parser.push('{"type":"end","stopReason":"end_turn"}\n');
  expect(messages).toEqual([
    'message:I found the [REDACTED]', 'tool:Running read_file', 'tool:read_file completed', 'status:Agent finished after 1 tool calls',
  ]);
  expect(messages.join(' ')).not.toContain('private reasoning');
  expect(messages.join(' ')).not.toContain('do-not-show');
  expect(messages.join(' ')).not.toContain('hidden');
});

test('rejects oversized and malformed events without leaking their contents', () => {
  const messages: string[] = [];
  const parser = createAgentActivityParser((_, message) => messages.push(message), (text) => text);
  parser.push('x'.repeat(128_001));
  parser.push('not json\n');
  parser.finish();
  expect(messages).toEqual(['Skipped an oversized agent event']);
});
