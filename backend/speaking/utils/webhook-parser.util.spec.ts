import { parseCalleWebhookEvent } from './webhook-parser.util';

const valid = () => ({
  id: 'evt_1',
  type: 'call.completed',
  created_at: '2026-09-06T10:05:00Z',
  data: {
    id: 'call_1',
    object: 'call_task',
    status: 'completed',
    task: 'Call…',
    recipients: [],
    structured_result: { topic: 'Coffee' },
    summary: 'ok',
    task_completed: true,
    completion_confidence: { score: 0.9, label: 'high' },
    evidence: ['x'],
    metadata: { kind: 'speaking', speakingCallId: 'sc-1' },
    failure_code: null,
    failure_message: null,
    created_at: '2026-09-06T10:00:00Z',
    completed_at: '2026-09-06T10:05:00Z',
    some_future_field: { nested: true },
  },
  another_future_top_level: 1,
});

describe('parseCalleWebhookEvent', () => {
  it('accepts a full event and tolerates unknown fields', () => {
    const event = parseCalleWebhookEvent(valid());
    expect(event).not.toBeNull();
    expect(event?.id).toBe('evt_1');
    expect(event?.type).toBe('call.completed');
    expect(event?.data.metadata).toEqual({
      kind: 'speaking',
      speakingCallId: 'sc-1',
    });
    expect(event?.data.structured_result).toEqual({ topic: 'Coffee' });
  });

  it('fills defaults for missing optional fields', () => {
    const body = valid();
    delete (body.data as Record<string, unknown>).recipients;
    delete (body.data as Record<string, unknown>).metadata;
    delete (body.data as Record<string, unknown>).evidence;
    delete (body as Record<string, unknown>).created_at;
    const event = parseCalleWebhookEvent(body);
    expect(event?.data.recipients).toEqual([]);
    expect(event?.data.metadata).toEqual({});
    expect(event?.data.evidence).toEqual([]);
    expect(typeof event?.created_at).toBe('string');
  });

  it.each<[unknown, string]>([
    [null, 'null'],
    ['string', 'string'],
    [[], 'array'],
    [{ ...valid(), id: '' }, 'empty id'],
    [{ ...valid(), type: 'call.started' }, 'unknown type'],
    [{ ...valid(), data: null }, 'no data'],
    [{ ...valid(), data: { ...valid().data, id: 7 } }, 'non-string call id'],
    [{ ...valid(), data: { ...valid().data, status: undefined } }, 'no status'],
  ])('rejects %p (%s)', (body) => {
    expect(parseCalleWebhookEvent(body)).toBeNull();
  });
});
