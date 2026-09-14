// modules
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cron from 'node-cron';
// observability
import { ObservabilityService } from 'modules/observability/observability.service';
import { runObservedOperation } from 'modules/observability/observability-runner';
// services
import { SpeakingCallService } from './services/speaking-call.service';

/**
 * Watchdog for calls whose webhook never came: polls CALL-E for overdue
 * calls and fails calls past the hard timeout. Every minute; each pass is
 * bounded (see sweepPendingCalls).
 */
@Injectable()
export class SpeakingScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SpeakingScheduler.name);
  private job: cron.ScheduledTask | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: ObservabilityService,
    private readonly calls: SpeakingCallService,
  ) {}

  onModuleInit(): void {
    const enabled =
      (this.config.get<boolean>('speaking.enabled') ?? true) &&
      (this.config.get<boolean>('speaking.schedulerEnabled') ?? true) &&
      process.env.NODE_ENV !== 'test';
    if (!enabled) {
      this.logger.log('Speaking scheduler is disabled');
      return;
    }
    this.job = cron.schedule('* * * * *', () => {
      void this.tick();
    });
    this.logger.log('Speaking scheduler initialized: * * * * *');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.job) {
      await this.job.stop();
      this.job = null;
    }
  }

  /** One sweep; re-entrancy guarded so a slow CALL-E cannot stack passes. */
  async tick(): Promise<{
    polled: number;
    settled: number;
    timedOut: number;
  } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await runObservedOperation(
        this.metrics,
        {
          metricPrefix: 'speaking_sweep',
          operationName: 'Speaking pending-call sweep',
        },
        async () => {
          const result = await this.calls.sweepPendingCalls();
          if (result.polled || result.timedOut) {
            this.logger.log(
              `Sweep: polled=${result.polled} settled=${result.settled} timedOut=${result.timedOut}`,
            );
          }
          return result;
        },
      );
    } finally {
      this.running = false;
    }
  }
}
