import type {
  CalleCallTask,
  CalleWebhookEvent,
  CalleWebhookEventType,
} from '../providers/calle.types';

const EVENT_TYPES: CalleWebhookEventType[] = [
  'call.completed',
  'call.failed',
  'call.result_validation_failed',
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Runtime guard for the CALL-E webhook body. The global ValidationPipe is
 * `forbidNonWhitelisted`, which would 400 on any field CALL-E adds later and
 * make their retries loop forever; the controller therefore takes the body
 * untyped and this function decides what is acceptable. Only the fields we
 * route on are checked; the task snapshot is passed through.
 */
export function parseCalleWebhookEvent(
  body: unknown,
): CalleWebhookEvent | null {
  if (!isRecord(body)) return null;
  const { id, type, created_at, data } = body;
  if (typeof id !== 'string' || !id.trim()) return null;
  if (
    typeof type !== 'string' ||
    !EVENT_TYPES.includes(type as CalleWebhookEventType)
  ) {
    return null;
  }
  if (!isRecord(data)) return null;
  if (typeof data.id !== 'string' || !data.id.trim()) return null;
  if (typeof data.status !== 'string') return null;

  const task: CalleCallTask = {
    id: data.id,
    object: 'call_task',
    status: data.status as CalleCallTask['status'],
    task: typeof data.task === 'string' ? data.task : '',
    recipients: Array.isArray(data.recipients)
      ? (data.recipients as CalleCallTask['recipients'])
      : [],
    structured_result: isRecord(data.structured_result)
      ? data.structured_result
      : null,
    summary: typeof data.summary === 'string' ? data.summary : null,
    task_completed: data.task_completed === true,
    completion_confidence: isRecord(data.completion_confidence)
      ? (data.completion_confidence as unknown as CalleCallTask['completion_confidence'])
      : null,
    evidence: Array.isArray(data.evidence) ? (data.evidence as string[]) : [],
    metadata: isRecord(data.metadata) ? data.metadata : {},
    failure_code:
      typeof data.failure_code === 'string' ? data.failure_code : null,
    failure_message:
      typeof data.failure_message === 'string' ? data.failure_message : null,
    created_at: typeof data.created_at === 'string' ? data.created_at : '',
    completed_at:
      typeof data.completed_at === 'string' ? data.completed_at : null,
  };

  return {
    id,
    type: type as CalleWebhookEventType,
    created_at:
      typeof created_at === 'string' ? created_at : new Date().toISOString(),
    data: task,
  };
}
