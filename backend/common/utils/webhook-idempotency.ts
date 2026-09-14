import { WebhookEventStatus, type PrismaClient } from '@prisma/client';
import { getCurrentUtcDate } from './date.util';

type Client = Pick<PrismaClient, 'processedWebhookEvent'>;

export type WebhookClaim = 'claimed' | 'already_done' | 'in_progress';

/** A PROCESSING row older than this is assumed to be a crashed attempt. */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/**
 * Two-phase idempotency for provider webhooks, shared across providers.
 *
 * Claim the event as PROCESSING before side-effects, flip it to DONE once
 * they commit. A crashed or failed attempt (stale PROCESSING / FAILED) is
 * safely re-processed on the provider's retry; only DONE is permanent.
 * Same state machine BillingService uses for RevenueCat, lifted out so a
 * second provider does not grow a second copy with its own bugs.
 */
export async function claimWebhookEvent(
  db: Client,
  provider: string,
  eventId: string,
  eventType: string | null,
  now: Date = getCurrentUtcDate(),
): Promise<WebhookClaim> {
  const key = { provider_eventId: { provider, eventId } };
  const existing = await db.processedWebhookEvent.findUnique({ where: key });

  if (!existing) {
    try {
      await db.processedWebhookEvent.create({
        data: {
          provider,
          eventId,
          eventType,
          status: WebhookEventStatus.PROCESSING,
        },
      });
      return 'claimed';
    } catch (error) {
      // Lost a race with a concurrent delivery of the same event.
      if ((error as { code?: string })?.code === 'P2002') {
        return 'in_progress';
      }
      throw error;
    }
  }

  if (existing.status === WebhookEventStatus.DONE) {
    return 'already_done';
  }

  if (existing.status === WebhookEventStatus.PROCESSING) {
    const ageMs = now.getTime() - existing.updatedAt.getTime();
    if (ageMs < STALE_PROCESSING_MS) {
      return 'in_progress';
    }
  }

  await db.processedWebhookEvent.update({
    where: key,
    data: {
      status: WebhookEventStatus.PROCESSING,
      attempts: { increment: 1 },
      lastError: null,
    },
  });
  return 'claimed';
}

export async function finishWebhookEvent(
  db: Client,
  provider: string,
  eventId: string,
  status: 'DONE' | 'FAILED',
  lastError?: string,
  now: Date = getCurrentUtcDate(),
): Promise<void> {
  await db.processedWebhookEvent.update({
    where: { provider_eventId: { provider, eventId } },
    data: {
      status:
        status === 'DONE' ? WebhookEventStatus.DONE : WebhookEventStatus.FAILED,
      processedAt: status === 'DONE' ? now : undefined,
      lastError:
        status === 'FAILED' ? (lastError ?? 'unknown').slice(0, 500) : null,
    },
  });
}
