import { describe, expect, test } from 'bun:test';
import { parseIncident, parseIncidentList } from '../src/incident';

const incident = {
  id: 'one', kind: 'runtime_regression', status: 'recovered', detectedAt: '2026-10-23T12:00:00Z', projectId: 'demo',
  evidence: ['first'], events: [{ at: '2026-10-23T12:00:02Z', type: 'later', message: 'later' }, { at: '2026-10-23T12:00:01Z', type: 'first', message: 'first' }],
};

describe('incident response parsing', () => {
  test('sorts events and list entries without trusting API order', () => {
    const parsed = parseIncidentList([incident, { ...incident, id: 'two', detectedAt: '2026-10-24T12:00:00Z' }]);
    expect(parsed.map(item => item.id)).toEqual(['two', 'one']);
    expect(parsed[1].events.map(event => event.type)).toEqual(['first', 'later']);
  });

  test('rejects duplicate IDs and invalid states', () => {
    expect(() => parseIncidentList([incident, incident])).toThrow('Duplicate incident IDs');
    expect(() => parseIncident({ ...incident, status: 'done' })).toThrow('Invalid incident state');
  });
});
