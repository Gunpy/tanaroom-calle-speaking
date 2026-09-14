import { SpeakingCallStatus } from '@prisma/client';
import type {
  CalleCallTask,
  CalleRecipientStatus,
} from '../providers/calle.types';
import {
  computeDurationSeconds,
  countUserTurns,
  pickPrimaryAttempt,
  turnsToMessages,
  type TranscriptMessageDraft,
} from './transcript.util';

/**
 * Attempt-level `failure_code` values CALL-E does not enumerate in the
 * OpenAPI file. Anything matching these is "the phone was not picked up",
 * which the product treats as a missed call rather than a failure.
 */
const MISSED_PATTERN =
  /no[_-]?answer|unanswered|not[_-]?answered|busy|declined|rejected|voicemail|no[_-]?pickup|ring[_-]?timeout|timeout/i;

export function isMissedFailureCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return MISSED_PATTERN.test(code);
}

export interface TerminalCallOutcome {
  status: SpeakingCallStatus;
  /** Set for failed/missed/partial; null when completed. */
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  messages: TranscriptMessageDraft[];
  userTurns: number;
  summary: string | null;
  topic: string | null;
  calleRecipientId: string | null;
  providerCallId: string | null;
}

export interface OutcomeThresholds {
  /** Minimum learner turns for the transcript to be worth keeping. */
  minAnalysisUserTurns: number;
}

const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const readTopic = (task: CalleCallTask): string | null => {
  const raw = task.structured_result?.topic;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed && trimmed.toLowerCase() !== 'unknown' ? trimmed : null;
};

/**
 * Collapses a terminal CALL-E task into one of our statuses:
 *
 *  - `completed`  — the call ran and left enough learner speech to analyse
 *  - `partial`    — the call ended abnormally but enough speech was captured
 *  - `missed`     — dialed, never answered
 *  - `failed`     — anything else, including "answered but nothing usable"
 *                   (`failureCode: insufficient_data`) so the UI can say
 *                   "we couldn't save enough of the conversation"
 *  - `cancelled`  — CALL-E reports canceled (we have no cancel API, but the
 *                   status exists in their contract)
 */
export function resolveTerminalOutcome(
  task: CalleCallTask,
  thresholds: OutcomeThresholds,
): TerminalCallOutcome {
  const recipient = task.recipients?.[0] ?? null;
  const attempt = pickPrimaryAttempt(recipient?.attempts);
  const messages = turnsToMessages(attempt?.transcript_turns ?? []);
  const userTurns = countUserTurns(messages);
  const enoughData = userTurns >= thresholds.minAnalysisUserTurns;

  const common = {
    startedAt: toDate(attempt?.started_at),
    endedAt: toDate(attempt?.completed_at ?? task.completed_at),
    durationSeconds: computeDurationSeconds(attempt),
    messages,
    userTurns,
    summary: task.summary ?? recipient?.summary ?? attempt?.summary ?? null,
    topic: readTopic(task),
    calleRecipientId: recipient?.id ?? null,
    providerCallId: attempt?.provider_call_id ?? null,
  };

  const attemptFailure = attempt?.failure_code ?? null;
  const taskFailure = task.failure_code ?? null;
  const failureCode = attemptFailure ?? taskFailure;
  const failureMessage =
    attempt?.failure_message ?? task.failure_message ?? null;

  if (task.status === 'canceled') {
    return {
      ...common,
      status: SpeakingCallStatus.cancelled,
      failureCode: failureCode ?? 'canceled',
      failureMessage,
    };
  }

  const answered = Boolean(attempt?.started_at) && messages.length > 0;

  if (!answered) {
    // Never connected: missed if the code says so, failed otherwise.
    const missed =
      isMissedFailureCode(attemptFailure) ||
      (task.status === 'completed' && !attempt?.started_at && !failureCode) ||
      (attempt?.status === 'failed' && !failureCode);
    return {
      ...common,
      status: missed ? SpeakingCallStatus.missed : SpeakingCallStatus.failed,
      failureCode: failureCode ?? (missed ? 'no_answer' : 'not_connected'),
      failureMessage,
    };
  }

  if (task.status === 'completed' && !attemptFailure) {
    if (enoughData) {
      return {
        ...common,
        status: SpeakingCallStatus.completed,
        failureCode: null,
        failureMessage: null,
      };
    }
    return {
      ...common,
      status: SpeakingCallStatus.failed,
      failureCode: 'insufficient_data',
      failureMessage: failureMessage ?? 'Not enough conversation captured',
    };
  }

  // failed status, or completed with an attempt-level failure: the call
  // connected but ended abnormally.
  if (enoughData) {
    return {
      ...common,
      status: SpeakingCallStatus.partial,
      failureCode: failureCode ?? 'ended_unexpectedly',
      failureMessage,
    };
  }
  return {
    ...common,
    status: SpeakingCallStatus.failed,
    failureCode: 'insufficient_data',
    failureMessage: failureMessage ?? 'Call ended before enough was captured',
  };
}

/** Statuses in which a call still occupies the user's single active slot. */
export const ACTIVE_CALL_STATUSES: SpeakingCallStatus[] = [
  SpeakingCallStatus.requested,
  SpeakingCallStatus.preparing,
  SpeakingCallStatus.calling,
  SpeakingCallStatus.connected,
];

const TERMINAL_CALL_STATUSES: SpeakingCallStatus[] = [
  SpeakingCallStatus.completed,
  SpeakingCallStatus.cancelled,
  SpeakingCallStatus.missed,
  SpeakingCallStatus.failed,
  SpeakingCallStatus.partial,
];

export function isTerminalStatus(status: SpeakingCallStatus): boolean {
  return TERMINAL_CALL_STATUSES.includes(status);
}

/**
 * Non-terminal CALL-E status → our in-progress status. The task-level status
 * stayed `queued` for a whole live lesson (2026-09-13), so the recipient's own
 * lifecycle (`dialing` / `in_progress`) is the signal the call screen needs.
 */
export function mapInProgressStatus(
  calleStatus: CalleCallTask['status'],
  hasStartedAttempt: boolean,
  recipientStatus?: CalleRecipientStatus | null,
): SpeakingCallStatus {
  if (recipientStatus === 'in_progress' || hasStartedAttempt) {
    return SpeakingCallStatus.connected;
  }
  if (recipientStatus === 'dialing') return SpeakingCallStatus.calling;
  if (calleStatus === 'queued') return SpeakingCallStatus.preparing;
  if (calleStatus === 'in_progress') return SpeakingCallStatus.calling;
  return SpeakingCallStatus.preparing;
}
