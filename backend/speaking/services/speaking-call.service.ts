// modules
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
// prisma
import { SpeakingCallStatus, type SpeakingCall } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
// observability
import { ObservabilityService } from 'modules/observability/observability.service';
import { runObservedOperation } from 'modules/observability/observability-runner';
import { SecurityEventService } from 'modules/observability/security-event.service';
// utils
import { getCurrentUtcDate } from 'common/utils/date.util';
import {
  ACTIVE_CALL_STATUSES,
  isTerminalStatus,
  mapInProgressStatus,
  resolveTerminalOutcome,
} from '../utils/call-status.util';
import { toCallView } from '../utils/call-view.util';
import { maskPhone } from '../utils/phone.util';
// providers
import {
  CALLE_PROVIDER,
  type CalleProvider,
} from '../providers/calle.provider.interface';
import {
  CalleApiError,
  type CalleCallTask,
  type CalleCreateCallRequest,
} from '../providers/calle.types';
// prompts
import {
  buildSpeakingCallTask,
  SPEAKING_CALL_RESULT_SCHEMA,
} from '../prompts/speaking-call-task.prompt';
// types
import type { SpeakingCallMetadata, SpeakingCallView } from '../speaking.types';

export interface RequestCallInput {
  idempotencyKey?: string;
}

export interface TerminalApplyResult {
  call: SpeakingCall;
  /** True when the transcript is worth analysing (completed / partial). */
  needsAnalysis: boolean;
}

/**
 * Requesting, tracking and settling calls. A call in any active status
 * occupies the user's single slot until a terminal result arrives from the
 * webhook, the live re-read or the minute sweep.
 *
 * Excerpt: plan limits, the free trial, charging and the post-call reward
 * are handled in the full service and are left out here.
 */
@Injectable()
export class SpeakingCallService {
  private readonly logger = new Logger(SpeakingCallService.name);
  /** CALL-E placements still running after the HTTP response; tests await them. */
  private readonly placements = new Map<string, Promise<void>>();
  /** Last on-demand CALL-E re-read per active call (ms epoch). */
  private readonly lastLiveRefresh = new Map<string, number>();
  /** Calls whose line has dropped while CALL-E still finalises the result. */
  private readonly wrappingUp = new Set<string>();

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: ObservabilityService,
    private readonly securityEvents: SecurityEventService,
    @Inject(CALLE_PROVIDER) private readonly calle: CalleProvider,
  ) {}

  async findActiveCall(userId: string): Promise<SpeakingCall | null> {
    return this.db.speakingCall.findFirst({
      where: { userId, status: { in: ACTIVE_CALL_STATUSES }, deletedAt: null },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async requestCall(
    userId: string,
    input: RequestCallInput,
  ): Promise<SpeakingCallView> {
    return runObservedOperation(
      this.metrics,
      {
        metricPrefix: 'speaking_request_call',
        operationName: 'Speaking request call',
      },
      async () => {
        if (!(this.config.get<boolean>('speaking.enabled') ?? true)) {
          throw new HttpException(
            {
              code: 'speaking_disabled',
              message: 'Speaking is temporarily unavailable.',
            },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }

        const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();
        const existing = await this.db.speakingCall.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          if (existing.userId !== userId) {
            throw new ForbiddenException({
              code: 'forbidden',
              message: 'Not your call.',
            });
          }
          return toCallView(existing);
        }

        const language = this.config.get<string>('speaking.language') ?? 'en';
        const [user, profile] = await Promise.all([
          this.db.user.findUnique({
            where: { id: userId },
            select: { level: true, nickname: true },
          }),
          this.db.speakingProfile.findUnique({ where: { userId } }),
        ]);
        if (!user) throw new NotFoundException('User not found');
        if (!profile?.phoneE164 || !profile.phoneVerifiedAt) {
          throw new ForbiddenException({
            code: 'phone_not_verified',
            message: 'Verify your phone number first.',
          });
        }
        if (!profile.consentAcceptedAt) {
          throw new ForbiddenException({
            code: 'consent_required',
            message: 'Accept AI-call consent first.',
          });
        }
        // The full service checks the plan allowance and the single active
        // call here before anything is written.

        const level = user.level || 'B1-B2';
        const region = this.config.get<string>('speaking.region') ?? 'US';

        const call = await this.db.speakingCall.create({
          data: {
            userId,
            language,
            level,
            phoneRegion: region,
            status: SpeakingCallStatus.requested,
            idempotencyKey,
          },
        });
        this.metrics.incCounter(
          'speaking_call_requested_total',
          'Calls requested',
          {},
          1,
        );

        const metadata: SpeakingCallMetadata = {
          kind: 'speaking',
          speakingCallId: call.id,
          userId,
        };
        const webhookUrl =
          this.config.get<string>('speaking.calleWebhookPublicUrl') || '';

        // CALL-E takes ~20s to accept a call while the app times out at 8s:
        // answer now with `requested`, place the call in the background and let
        // the call screen's polling pick up preparing/calling/failed.
        const placement = this.placeCall(call.id, profile.phoneE164, {
          task: buildSpeakingCallTask({
            phoneE164: profile.phoneE164,
            learnerName: user.nickname,
            cefrLevel: level,
            maxCallMinutes:
              this.config.get<number>('speaking.maxCallMinutes') ?? 5,
          }),
          recipients: [
            {
              phones: [profile.phoneE164],
              locale: this.config.get<string>('speaking.locale') ?? 'en-US',
              region,
            },
          ],
          result_schema: SPEAKING_CALL_RESULT_SCHEMA,
          metadata,
          ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
        });
        this.placements.set(call.id, placement);
        void placement.finally(() => this.placements.delete(call.id));
        return toCallView(call);
      },
    );
  }

  /**
   * The call screen polls us every few seconds while a call is active, but the
   * sweep only re-reads CALL-E once a minute: re-read on demand when the
   * stored snapshot is older than `liveRefreshSeconds`. Failures keep the
   * stale row — the webhook and the sweep still settle the call.
   */
  private async refreshIfLive(call: SpeakingCall): Promise<SpeakingCall> {
    if (!call.calleCallId || !ACTIVE_CALL_STATUSES.includes(call.status)) {
      return call;
    }
    const intervalMs =
      (this.config.get<number>('speaking.liveRefreshSeconds') ?? 15) * 1000;
    const now = Date.now();
    const last = this.lastLiveRefresh.get(call.id) ?? 0;
    if (now - last < intervalMs) return call;
    this.lastLiveRefresh.set(call.id, now);
    try {
      const task = await this.calle.getCall(call.calleCallId);
      const terminal =
        task.status === 'completed' ||
        task.status === 'failed' ||
        task.status === 'canceled';
      // CALL-E finalises for ~40s after the line drops; the attempt already
      // says so, and the call screen can stop pretending the call is live.
      const attempt = task.recipients?.[0]?.attempts?.slice(-1)[0];
      const lineDropped =
        Boolean(attempt?.completed_at) ||
        attempt?.status === 'completed' ||
        attempt?.status === 'failed' ||
        attempt?.status === 'canceled';
      if (terminal) this.wrappingUp.delete(call.id);
      else if (lineDropped) this.wrappingUp.add(call.id);
      // Settling stays with the webhook and the sweep; the read path only
      // moves the live status forward.
      const updated = terminal
        ? call
        : await this.applyInProgressTask(call, task);
      this.metrics.incCounter(
        'speaking_live_refresh_total',
        'On-demand CALL-E re-reads for active calls',
        { outcome: terminal ? 'terminal_deferred' : 'refreshed' },
        1,
      );
      if (terminal) this.lastLiveRefresh.delete(call.id);
      return updated;
    } catch (error) {
      this.metrics.incCounter(
        'speaking_live_refresh_total',
        'On-demand CALL-E re-reads for active calls',
        { outcome: 'failed' },
        1,
      );
      this.logger.warn(
        `Live refresh failed for call ${call.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return call;
    }
  }

  /** Resolves once the background CALL-E placement for `callId` has settled. */
  async awaitPlacement(callId: string): Promise<void> {
    await (this.placements.get(callId) ?? Promise.resolve());
  }

  private async placeCall(
    callId: string,
    phoneE164: string,
    request: CalleCreateCallRequest,
  ): Promise<void> {
    let task: CalleCallTask;
    try {
      task = await this.calle.createCall(request, {
        idempotencyKey: `speaking:${callId}`,
      });
    } catch (error) {
      const code = error instanceof CalleApiError ? error.code : 'unknown';
      this.metrics.incCounter(
        'speaking_call_create_failed_total',
        'CALL-E create-call failures',
        { code },
        1,
      );
      this.logger.error(
        `CALL-E create failed for call ${callId} (${maskPhone(phoneE164)}): ${code}`,
      );
      try {
        await this.db.speakingCall.updateMany({
          where: { id: callId, status: SpeakingCallStatus.requested },
          data: {
            status: SpeakingCallStatus.failed,
            failureCode: `create_failed:${code}`,
            failureMessage:
              error instanceof Error ? error.message : String(error),
            endedAt: getCurrentUtcDate(),
          },
        });
      } catch (dbError) {
        this.logger.error(
          `Could not mark call ${callId} as create_failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        );
      }
      return;
    }

    try {
      // The user may have cancelled while CALL-E was accepting the call: keep
      // the ids so the terminal webhook still matches, but never revive the row.
      const ids = {
        calleCallId: task.id,
        calleRecipientId: task.recipients?.[0]?.id ?? null,
      };
      const moved = await this.db.speakingCall.updateMany({
        where: { id: callId, status: SpeakingCallStatus.requested },
        data: {
          ...ids,
          status: mapInProgressStatus(
            task.status,
            false,
            task.recipients?.[0]?.status ?? null,
          ),
        },
      });
      if (moved.count === 0) {
        await this.db.speakingCall.updateMany({
          where: { id: callId },
          data: ids,
        });
      }
    } catch (dbError) {
      this.logger.error(
        `Could not attach CALL-E call ${task.id} to ${callId}: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
      );
    }
  }

  async getCall(userId: string, callId: string): Promise<SpeakingCallView> {
    return runObservedOperation(
      this.metrics,
      { metricPrefix: 'speaking_get_call', operationName: 'Speaking get call' },
      async () => {
        const call = await this.refreshIfLive(
          await this.loadOwned(userId, callId),
        );
        // The full service also attaches feedback counters and the reward.
        return {
          ...toCallView(call),
          wrappingUp:
            !isTerminalStatus(call.status) && this.wrappingUp.has(call.id),
        };
      },
    );
  }

  /**
   * CALL-E has no cancel endpoint. We mark our record cancelled so the UI
   * moves on; the terminal webhook, if it arrives later, is applied as
   * "cancelled by user" unless a real conversation happened anyway.
   */
  async cancelCall(userId: string, callId: string): Promise<SpeakingCallView> {
    return runObservedOperation(
      this.metrics,
      {
        metricPrefix: 'speaking_cancel_call',
        operationName: 'Speaking cancel call',
      },
      async () => {
        const call = await this.loadOwned(userId, callId);
        if (isTerminalStatus(call.status)) {
          throw new ConflictException({
            code: 'call_already_finished',
            message: 'This call has already finished.',
          });
        }
        const updated = await this.db.speakingCall.update({
          where: { id: call.id },
          data: {
            status: SpeakingCallStatus.cancelled,
            endedAt: getCurrentUtcDate(),
          },
        });
        this.metrics.incCounter(
          'speaking_call_cancelled_total',
          'Calls cancelled by user',
          {},
          1,
        );
        return toCallView(updated);
      },
    );
  }

  /**
   * Settle a call from a terminal CALL-E snapshot (webhook or poll). Safe to
   * call more than once: the transcript is replaced, not appended, and the
   * outcome is derived from the same inputs each time.
   */
  async applyTerminalTask(
    call: SpeakingCall,
    task: CalleCallTask,
  ): Promise<TerminalApplyResult> {
    return runObservedOperation(
      this.metrics,
      {
        metricPrefix: 'speaking_apply_terminal',
        operationName: 'Speaking apply terminal result',
        labels: { calle_status: task.status },
      },
      async () => {
        const outcome = resolveTerminalOutcome(task, {
          minAnalysisUserTurns:
            this.config.get<number>('speaking.minAnalysisUserTurns') ?? 2,
        });
        // CALL-E cannot cancel a placed call, so a "cancelled" request can
        // still turn into a real lesson; when it does, it is a real call.
        const minChargeSeconds =
          this.config.get<number>('speaking.minChargeSeconds') ?? 60;
        const minUserTurns =
          this.config.get<number>('speaking.minUserTurns') ?? 2;
        this.wrappingUp.delete(call.id);
        const wasCancelled = call.status === SpeakingCallStatus.cancelled;
        const conversationHappened =
          (outcome.durationSeconds ?? 0) >= minChargeSeconds &&
          outcome.userTurns >= minUserTurns;
        const cancelledByUser = wasCancelled && !conversationHappened;
        if (wasCancelled && conversationHappened) {
          this.metrics.incCounter(
            'speaking_call_revived_total',
            'Cancelled requests that still became a real call',
            {},
            1,
          );
        }
        const finalStatus = cancelledByUser
          ? SpeakingCallStatus.cancelled
          : outcome.status;

        const needsAnalysis =
          !cancelledByUser &&
          (finalStatus === SpeakingCallStatus.completed ||
            finalStatus === SpeakingCallStatus.partial) &&
          outcome.messages.length > 0;

        const now = getCurrentUtcDate();
        const updated = await this.db.$transaction(async (tx) => {
          await tx.speakingTranscriptMessage.deleteMany({
            where: { callId: call.id },
          });
          if (outcome.messages.length) {
            await tx.speakingTranscriptMessage.createMany({
              data: outcome.messages.map((m) => ({ ...m, callId: call.id })),
            });
          }
          return tx.speakingCall.update({
            where: { id: call.id },
            data: {
              status: finalStatus,
              startedAt: outcome.startedAt,
              endedAt: outcome.endedAt ?? now,
              durationSeconds: outcome.durationSeconds,
              summary: outcome.summary,
              topic: call.topic ?? outcome.topic,
              calleRecipientId:
                outcome.calleRecipientId ?? call.calleRecipientId,
              providerCallId: outcome.providerCallId ?? call.providerCallId,
              failureCode: cancelledByUser
                ? call.failureCode
                : outcome.failureCode,
              failureMessage: cancelledByUser
                ? call.failureMessage
                : outcome.failureMessage,
            },
          });
        });

        this.metrics.incCounter(
          'speaking_call_terminal_total',
          'Calls reaching a terminal state',
          { status: finalStatus },
          1,
        );
        if (outcome.durationSeconds !== null) {
          this.metrics.observeHistogram(
            'speaking_call_duration_seconds',
            'Connected duration of speaking calls',
            { status: finalStatus },
            outcome.durationSeconds,
            [10, 30, 60, 120, 180, 240, 300, 360, 600],
          );
        }

        return { call: updated, needsAnalysis };
      },
    );
  }

  /** Non-terminal snapshot from polling: only the status moves. */
  async applyInProgressTask(
    call: SpeakingCall,
    task: CalleCallTask,
  ): Promise<SpeakingCall> {
    if (isTerminalStatus(call.status)) return call;
    const attempt = task.recipients?.[0]?.attempts?.slice(-1)[0];
    const status = mapInProgressStatus(
      task.status,
      Boolean(attempt?.started_at),
      task.recipients?.[0]?.status ?? null,
    );
    if (status === call.status) return call;
    return this.db.speakingCall.update({
      where: { id: call.id },
      data: {
        status,
        startedAt: attempt?.started_at
          ? new Date(attempt.started_at)
          : call.startedAt,
      },
    });
  }

  /**
   * Scheduler entry: poll calls whose webhook is overdue and time out calls
   * that never resolved. Returns what it did for the metrics line.
   */
  async sweepPendingCalls(): Promise<{
    polled: number;
    settled: number;
    timedOut: number;
  }> {
    const now = getCurrentUtcDate();
    const grace =
      this.config.get<number>('speaking.webhookGraceSeconds') ?? 120;
    const timeout =
      this.config.get<number>('speaking.callTimeoutSeconds') ?? 900;

    const stale = await this.db.speakingCall.findMany({
      where: {
        status: { in: ACTIVE_CALL_STATUSES },
        requestedAt: { lt: new Date(now.getTime() - timeout * 1000) },
      },
      take: 100,
    });
    let timedOut = 0;
    for (const call of stale) {
      await this.db.speakingCall.update({
        where: { id: call.id },
        data: {
          status: SpeakingCallStatus.failed,
          failureCode: 'timeout',
          failureMessage: `No terminal result within ${timeout}s`,
          endedAt: now,
        },
      });
      timedOut += 1;
    }
    if (timedOut) {
      this.metrics.incCounter(
        'speaking_call_timed_out_total',
        'Calls timed out by watchdog',
        {},
        timedOut,
      );
    }

    const overdue = await this.db.speakingCall.findMany({
      where: {
        status: { in: ACTIVE_CALL_STATUSES },
        calleCallId: { not: null },
        requestedAt: {
          lt: new Date(now.getTime() - grace * 1000),
          gte: new Date(now.getTime() - timeout * 1000),
        },
      },
      take: 50,
    });
    let polled = 0;
    let settled = 0;
    for (const call of overdue) {
      if (!call.calleCallId) continue;
      polled += 1;
      try {
        const task = await this.calle.getCall(call.calleCallId);
        if (
          task.status === 'completed' ||
          task.status === 'failed' ||
          task.status === 'canceled'
        ) {
          await this.applyTerminalTask(call, task);
          settled += 1;
        } else {
          await this.applyInProgressTask(call, task);
        }
      } catch (error) {
        this.logger.warn(
          `Poll failed for call ${call.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { polled, settled, timedOut };
  }

  async loadOwned(userId: string, callId: string): Promise<SpeakingCall> {
    const call = await this.db.speakingCall.findFirst({
      where: { id: callId, deletedAt: null },
    });
    if (!call)
      throw new NotFoundException({
        code: 'call_not_found',
        message: 'Call not found.',
      });
    if (call.userId !== userId) {
      await this.securityEvents.emit({
        event: 'speaking.call.ownership_violation',
        severity: 'warning',
        userId,
        metadata: { callId },
      });
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Not your call.',
      });
    }
    return call;
  }
}
