import { SpeakingCallStatus } from '@prisma/client';
import type { CalleAttempt, CalleCallTask } from '../providers/calle.types';
import {
  ACTIVE_CALL_STATUSES,
  isMissedFailureCode,
  isTerminalStatus,
  mapInProgressStatus,
  resolveTerminalOutcome,
} from './call-status.util';

const turns = (userCount: number) => {
  const out: CalleAttempt['transcript_turns'] = [
    { offset_seconds: 0, speaker: 'bot', text: 'Hi! It’s Tanar.' },
  ];
  for (let i = 0; i < userCount; i += 1) {
    out.push({
      offset_seconds: 10 + i * 20,
      speaker: 'user',
      text: `Turn ${i}`,
    });
    out.push({
      offset_seconds: 20 + i * 20,
      speaker: 'bot',
      text: `Reply ${i}`,
    });
  }
  return out;
};

const attempt = (overrides: Partial<CalleAttempt> = {}): CalleAttempt => ({
  id: 'att_1',
  phone: '+14155550123',
  status: 'completed',
  started_at: '2026-09-06T10:00:05Z',
  completed_at: '2026-09-06T10:04:50Z',
  summary: 'Talked about coffee.',
  transcript_turns: turns(6),
  provider_call_id: 'prov_1',
  failure_code: null,
  failure_message: null,
  ...overrides,
});

const task = (
  overrides: Partial<CalleCallTask> = {},
  attemptOverrides: Partial<CalleAttempt> = {},
): CalleCallTask => ({
  id: 'call_1',
  object: 'call_task',
  status: 'completed',
  task: 'Call the learner',
  recipients: [
    {
      id: 'rcp_1',
      phones: ['+14155550123'],
      locale: 'en-US',
      region: 'US',
      status: 'completed',
      structured_result: { topic: 'Coffee shop' },
      summary: 'Recipient summary',
      attempts: [attempt(attemptOverrides)],
    },
  ],
  structured_result: { topic: 'Coffee shop' },
  summary: 'Task summary',
  task_completed: true,
  completion_confidence: { score: 0.9, label: 'high' },
  evidence: [],
  metadata: {},
  failure_code: null,
  failure_message: null,
  created_at: '2026-09-06T10:00:00Z',
  completed_at: '2026-09-06T10:04:55Z',
  ...overrides,
});

const thresholds = { minAnalysisUserTurns: 2 };

describe('call-status.util', () => {
  describe('isMissedFailureCode', () => {
    it.each([
      'no_answer',
      'NO-ANSWER',
      'unanswered',
      'busy',
      'declined',
      'voicemail',
      'ring_timeout',
    ])('treats %s as missed', (code) =>
      expect(isMissedFailureCode(code)).toBe(true),
    );
    it.each([null, undefined, '', 'provider_unavailable', 'policy_violation'])(
      'does not treat %s as missed',
      (code) => expect(isMissedFailureCode(code)).toBe(false),
    );
  });

  describe('resolveTerminalOutcome', () => {
    it('marks a normal call completed and carries the metadata over', () => {
      const outcome = resolveTerminalOutcome(task(), thresholds);
      expect(outcome.status).toBe(SpeakingCallStatus.completed);
      expect(outcome.failureCode).toBeNull();
      expect(outcome.durationSeconds).toBe(285);
      expect(outcome.userTurns).toBe(6);
      expect(outcome.topic).toBe('Coffee shop');
      expect(outcome.summary).toBe('Task summary');
      expect(outcome.calleRecipientId).toBe('rcp_1');
      expect(outcome.providerCallId).toBe('prov_1');
      expect(outcome.startedAt?.toISOString()).toBe('2026-09-06T10:00:05.000Z');
    });

    it('ignores an "unknown" topic from the extraction model', () => {
      const outcome = resolveTerminalOutcome(
        task({ structured_result: { topic: 'unknown' } }),
        thresholds,
      );
      expect(outcome.topic).toBeNull();
    });

    it('is missed when the attempt failed with a no-answer code', () => {
      const outcome = resolveTerminalOutcome(
        task(
          { status: 'failed' },
          {
            status: 'failed',
            started_at: null,
            completed_at: null,
            transcript_turns: [],
            failure_code: 'no_answer',
            failure_message: 'Nobody picked up',
          },
        ),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.missed);
      expect(outcome.failureCode).toBe('no_answer');
      expect(outcome.messages).toEqual([]);
    });

    it('is missed when CALL-E completed the task without ever starting the dial', () => {
      const outcome = resolveTerminalOutcome(
        task(
          {},
          { started_at: null, completed_at: null, transcript_turns: [] },
        ),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.missed);
      expect(outcome.failureCode).toBe('no_answer');
    });

    it('is failed when it never connected for a non-missed reason', () => {
      const outcome = resolveTerminalOutcome(
        task(
          { status: 'failed', failure_code: 'provider_unavailable' },
          {
            status: 'failed',
            started_at: null,
            transcript_turns: [],
            failure_code: 'provider_unavailable',
          },
        ),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.failed);
      expect(outcome.failureCode).toBe('provider_unavailable');
    });

    it('is failed with insufficient_data when answered but the learner barely spoke', () => {
      const outcome = resolveTerminalOutcome(
        task({}, { transcript_turns: turns(1) }),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.failed);
      expect(outcome.failureCode).toBe('insufficient_data');
      expect(outcome.userTurns).toBe(1);
    });

    it('is partial when the call dropped but enough was captured', () => {
      const outcome = resolveTerminalOutcome(
        task(
          { status: 'failed' },
          {
            status: 'failed',
            failure_code: 'connection_lost',
            failure_message: 'Carrier dropped',
            transcript_turns: turns(3),
          },
        ),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.partial);
      expect(outcome.failureCode).toBe('connection_lost');
      expect(outcome.failureMessage).toBe('Carrier dropped');
    });

    it('is partial when completed but the attempt carries a failure code', () => {
      const outcome = resolveTerminalOutcome(
        task(
          {},
          { failure_code: 'hangup_timeout', transcript_turns: turns(4) },
        ),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.partial);
    });

    it('falls back to ended_unexpectedly when a partial call has no code', () => {
      const outcome = resolveTerminalOutcome(
        task({ status: 'failed' }, { transcript_turns: turns(3) }),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.partial);
      expect(outcome.failureCode).toBe('ended_unexpectedly');
    });

    it('is failed with insufficient_data when dropped early', () => {
      const outcome = resolveTerminalOutcome(
        task(
          { status: 'failed' },
          { failure_code: 'connection_lost', transcript_turns: turns(1) },
        ),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.failed);
      expect(outcome.failureCode).toBe('insufficient_data');
    });

    it('maps a canceled task to cancelled', () => {
      const outcome = resolveTerminalOutcome(
        task({ status: 'canceled' }),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.cancelled);
      expect(outcome.failureCode).toBe('canceled');
    });

    it('survives a task with no recipients at all', () => {
      const outcome = resolveTerminalOutcome(
        task({
          status: 'failed',
          recipients: [],
          failure_code: 'no_recipients',
        }),
        thresholds,
      );
      expect(outcome.status).toBe(SpeakingCallStatus.failed);
      expect(outcome.failureCode).toBe('no_recipients');
      expect(outcome.durationSeconds).toBeNull();
      expect(outcome.calleRecipientId).toBeNull();
    });
  });

  describe('status helpers', () => {
    it('knows which statuses are terminal', () => {
      expect(isTerminalStatus(SpeakingCallStatus.completed)).toBe(true);
      expect(isTerminalStatus(SpeakingCallStatus.missed)).toBe(true);
      expect(isTerminalStatus(SpeakingCallStatus.calling)).toBe(false);
      expect(ACTIVE_CALL_STATUSES).not.toContain(SpeakingCallStatus.completed);
    });

    it('maps in-progress CALL-E statuses', () => {
      expect(mapInProgressStatus('queued', false)).toBe(
        SpeakingCallStatus.preparing,
      );
      expect(mapInProgressStatus('in_progress', false)).toBe(
        SpeakingCallStatus.calling,
      );
      expect(mapInProgressStatus('in_progress', true)).toBe(
        SpeakingCallStatus.connected,
      );
      expect(mapInProgressStatus('completed', true)).toBe(
        SpeakingCallStatus.connected,
      );
    });

    it('trusts the recipient lifecycle when the task still says queued', () => {
      expect(mapInProgressStatus('queued', false, 'dialing')).toBe(
        SpeakingCallStatus.calling,
      );
      expect(mapInProgressStatus('queued', false, 'in_progress')).toBe(
        SpeakingCallStatus.connected,
      );
      expect(mapInProgressStatus('queued', false, 'queued')).toBe(
        SpeakingCallStatus.preparing,
      );
    });
  });
});
