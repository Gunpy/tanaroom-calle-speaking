// modules
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
// prisma
import { PrismaService } from 'prisma/prisma.service';
// observability
import { ObservabilityService } from 'modules/observability/observability.service';
import { runObservedOperation } from 'modules/observability/observability-runner';
import { SecurityEventService } from 'modules/observability/security-event.service';
// utils
import {
  claimWebhookEvent,
  finishWebhookEvent,
} from 'common/utils/webhook-idempotency';
import { parseCalleWebhookEvent } from '../utils/webhook-parser.util';
// providers
import {
  CALLE_PROVIDER,
  type CalleProvider,
} from '../providers/calle.provider.interface';
import type {
  CalleCallTask,
  CalleWebhookEvent,
} from '../providers/calle.types';
// services
import { SpeakingCallService } from './speaking-call.service';

export type WebhookOutcome =
  | 'ignored'
  | 'duplicate'
  | 'in_progress'
  | 'call_settled'
  | 'call_unknown';

const PROVIDER = 'calle';

/**
 * Receives terminal CALL-E events. CALL-E signs nothing: the shared token in
 * the path is compared in constant time, the `CALL-E-Event-Id` header must
 * match the body (their docs: reject mismatches with 400), every event id goes
 * through the two-phase idempotency table, and before a speaking call is
 * settled the snapshot is re-read with `GET /v1/calls/{id}` — the only proof of
 * origin their docs offer.
 */
@Injectable()
export class SpeakingWebhookService {
  private readonly logger = new Logger(SpeakingWebhookService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: ObservabilityService,
    private readonly securityEvents: SecurityEventService,
    private readonly calls: SpeakingCallService,
    @Inject(CALLE_PROVIDER) private readonly calle: CalleProvider,
  ) {}

  /** Constant-time comparison of the path token against the configured one. */
  isValidToken(token: string | undefined, ip?: string | null): boolean {
    const expected =
      this.config.get<string>('speaking.calleWebhookToken') || '';
    if (!expected || !token) {
      void this.securityEvents.emit({
        event: 'speaking.webhook.rejected',
        severity: 'warning',
        ip: ip ?? null,
        metadata: {
          reason: expected ? 'missing_token' : 'token_not_configured',
        },
      });
      return false;
    }
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      void this.securityEvents.emit({
        event: 'speaking.webhook.rejected',
        severity: 'warning',
        ip: ip ?? null,
        metadata: { reason: 'bad_token' },
      });
    }
    return ok;
  }

  /**
   * Controller entry: untyped body → parsed event → handled. `eventIdHeader`
   * is the `CALL-E-Event-Id` delivery header; when present it must equal the
   * body's event id.
   */
  async handleBody(
    body: unknown,
    eventIdHeader: string | null = null,
    ip: string | null = null,
  ): Promise<{ ok: true; outcome: WebhookOutcome }> {
    const event = parseCalleWebhookEvent(body);
    if (!event) {
      this.metrics.incCounter(
        'speaking_webhook_total',
        'CALL-E webhooks',
        { outcome: 'malformed' },
        1,
      );
      return { ok: true, outcome: 'ignored' };
    }
    const header = eventIdHeader?.trim() ?? '';
    if (header && header !== event.id) {
      this.metrics.incCounter(
        'speaking_webhook_total',
        'CALL-E webhooks',
        { outcome: 'event_id_mismatch' },
        1,
      );
      await this.securityEvents.emit({
        event: 'speaking.webhook.event_id_mismatch',
        severity: 'warning',
        ip,
        metadata: { header, bodyId: event.id },
      });
      throw new BadRequestException('Webhook event id mismatch');
    }
    const outcome = await this.handleEvent(event);
    return { ok: true, outcome };
  }

  async handleEvent(event: CalleWebhookEvent): Promise<WebhookOutcome> {
    return runObservedOperation(
      this.metrics,
      {
        metricPrefix: 'speaking_webhook_handle',
        operationName: 'Speaking webhook handle',
        labels: { event_type: event.type },
      },
      async () => {
        const claim = await claimWebhookEvent(
          this.db,
          PROVIDER,
          event.id,
          event.type,
        );
        if (claim === 'already_done') {
          this.metrics.incCounter(
            'speaking_webhook_total',
            'CALL-E webhooks',
            { outcome: 'duplicate' },
            1,
          );
          return 'duplicate';
        }
        if (claim === 'in_progress') {
          this.metrics.incCounter(
            'speaking_webhook_total',
            'CALL-E webhooks',
            { outcome: 'in_progress' },
            1,
          );
          return 'in_progress';
        }

        try {
          const outcome = await this.route(event);
          await finishWebhookEvent(this.db, PROVIDER, event.id, 'DONE');
          this.metrics.incCounter(
            'speaking_webhook_total',
            'CALL-E webhooks',
            { outcome },
            1,
          );
          return outcome;
        } catch (error) {
          await finishWebhookEvent(
            this.db,
            PROVIDER,
            event.id,
            'FAILED',
            error instanceof Error ? error.message : String(error),
          );
          this.metrics.incCounter(
            'speaking_webhook_total',
            'CALL-E webhooks',
            { outcome: 'error' },
            1,
          );
          throw error;
        }
      },
    );
  }

  private async route(event: CalleWebhookEvent): Promise<WebhookOutcome> {
    const task = event.data;
    const speakingCallId = task.metadata?.speakingCallId;
    const call =
      (typeof speakingCallId === 'string'
        ? await this.db.speakingCall.findUnique({
            where: { id: speakingCallId },
          })
        : null) ??
      (await this.db.speakingCall.findUnique({
        where: { calleCallId: task.id },
      }));

    if (!call) {
      this.logger.warn(
        `Webhook for unknown call ${task.id} (event ${event.id})`,
      );
      await this.securityEvents.emit({
        event: 'speaking.webhook.unknown_call',
        severity: 'info',
        metadata: { calleCallId: task.id, eventId: event.id },
      });
      return 'call_unknown';
    }

    if (call.calleCallId && call.calleCallId !== task.id) {
      // metadata says one call, the snapshot id says another: treat as forged.
      await this.securityEvents.emit({
        event: 'speaking.webhook.call_id_mismatch',
        severity: 'warning',
        userId: call.userId,
        metadata: {
          expected: call.calleCallId,
          received: task.id,
          eventId: event.id,
        },
      });
      return 'ignored';
    }

    // `needsAnalysis` hands the transcript to the post-call analysis in the
    // full service, after CALL-E has received its 200.
    await this.calls.applyTerminalTask(
      call,
      await this.confirmTask(task, call.userId),
    );
    return 'call_settled';
  }

  /**
   * Re-reads the call from CALL-E before settling it. A webhook body carries
   * no proof of origin; the API does. When the read fails the snapshot is
   * used, recorded as a security event, so an outage never strands a call.
   */
  private async confirmTask(
    snapshot: CalleCallTask,
    userId: string,
  ): Promise<CalleCallTask> {
    try {
      const fetched = await this.calle.getCall(snapshot.id);
      if (fetched && fetched.id === snapshot.id) {
        this.metrics.incCounter(
          'speaking_webhook_confirm_total',
          'CALL-E webhook snapshots re-read from the API',
          { outcome: 'confirmed' },
          1,
        );
        return fetched;
      }
    } catch (error) {
      this.logger.warn(
        `Could not confirm call ${snapshot.id} via CALL-E: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.securityEvents.emit({
        event: 'speaking.webhook.confirm_failed',
        severity: 'info',
        userId,
        metadata: { calleCallId: snapshot.id },
      });
    }
    this.metrics.incCounter(
      'speaking_webhook_confirm_total',
      'CALL-E webhook snapshots re-read from the API',
      { outcome: 'snapshot' },
      1,
    );
    return snapshot;
  }
}
