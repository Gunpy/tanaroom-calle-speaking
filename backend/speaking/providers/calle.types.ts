/**
 * CALL-E Developer API v0.7.0 contract (docs.heycall-e.com/openapi/calle.openapi.yaml).
 * Snake_case is preserved on purpose: these are wire types, mapped to our
 * camelCase domain in `utils/call-status.util.ts`.
 */

type CalleCallStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Per the OpenAPI RecipientStatus enum; `pending`/`skipped` kept for older payloads. */
export type CalleRecipientStatus =
  | 'queued'
  | 'dialing'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'skipped';

type CalleAttemptStatus =
  | 'queued'
  | 'dialing'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'canceled';

type CalleTranscriptSpeaker = 'bot' | 'user' | 'unknown';

export interface CalleTranscriptTurn {
  offset_seconds: number;
  speaker: CalleTranscriptSpeaker;
  text: string;
}

export interface CalleAttempt {
  id: string;
  phone: string;
  status: CalleAttemptStatus;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  transcript_turns: CalleTranscriptTurn[];
  provider_call_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
}

interface CalleRecipient {
  id: string;
  phones: string[];
  locale: string | null;
  region: string | null;
  status: CalleRecipientStatus;
  structured_result: Record<string, unknown> | null;
  summary: string | null;
  attempts: CalleAttempt[];
}

interface CalleCompletionConfidence {
  score: number;
  label: string;
}

export interface CalleCallTask {
  id: string;
  object: 'call_task';
  status: CalleCallStatus;
  task: string;
  recipients: CalleRecipient[];
  structured_result: Record<string, unknown> | null;
  summary: string | null;
  task_completed: boolean;
  completion_confidence: CalleCompletionConfidence | null;
  evidence: string[];
  metadata: Record<string, unknown>;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export type CalleWebhookEventType =
  | 'call.completed'
  | 'call.failed'
  | 'call.result_validation_failed';

export interface CalleWebhookEvent {
  id: string;
  type: CalleWebhookEventType;
  created_at: string;
  data: CalleCallTask;
}

interface CalleRecipientRequest {
  phones: string[];
  locale?: string | null;
  region?: string | null;
}

export interface CalleCreateCallRequest {
  task: string;
  recipients?: CalleRecipientRequest[] | null;
  result_schema?: Record<string, unknown> | null;
  recipient_result_schema?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  webhook_url?: string;
}

/** `error.code` values CALL-E documents. Anything else is `unknown`. */
const CALLE_API_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'rate_limit_exceeded',
  'insufficient_balance',
  'unsupported_region',
  'unsupported_language',
  'recipient_blocked',
  'policy_violation',
  'call_not_ready',
  'no_recipients',
  'invalid_recipient',
  'invalid_phone',
  'result_schema_invalid',
  'recipient_result_schema_invalid',
  'idempotency_conflict',
  'goal_not_published',
  'goal_not_executable',
  'goal_not_ready',
  'schema_override_not_allowed',
  'variables_invalid',
  'provider_unavailable',
  'internal_error',
  'not_found',
] as const;

export type CalleApiErrorCode = (typeof CALLE_API_ERROR_CODES)[number];

export interface CalleApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class CalleApiError extends Error {
  readonly code: CalleApiErrorCode | 'unknown';
  readonly httpStatus: number;
  readonly retryAfterSeconds: number | null;
  /** Our request timer fired; CALL-E may still have processed the request. */
  readonly timedOut: boolean;

  constructor(params: {
    code: string;
    message: string;
    httpStatus: number;
    retryAfterSeconds?: number | null;
    timedOut?: boolean;
  }) {
    super(params.message);
    this.name = 'CalleApiError';
    this.timedOut = params.timedOut ?? false;
    this.code = (CALLE_API_ERROR_CODES as readonly string[]).includes(
      params.code,
    )
      ? (params.code as CalleApiErrorCode)
      : 'unknown';
    this.httpStatus = params.httpStatus;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
  }

  /** Errors where a retry with the same input could succeed. */
  get isTransient(): boolean {
    return (
      this.code === 'rate_limit_exceeded' ||
      this.code === 'provider_unavailable' ||
      this.code === 'internal_error' ||
      this.httpStatus >= 500
    );
  }
}
