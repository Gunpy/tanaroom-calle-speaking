// modules
import { registerAs } from '@nestjs/config';

const int = (value: string | undefined, fallback: number): number => {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
};

/** Speaking (CALL-E) configuration. Every threshold is env-driven so it can be tuned without a deploy. */
export default registerAs('speaking', () => ({
  enabled: bool(process.env.SPEAKING_ENABLED, true),
  // `fake` replays the full call lifecycle in-process so the feature can be
  // built and demoed before a CALL-E key exists; `calle` is the real API.
  provider: (process.env.SPEAKING_PROVIDER || 'fake') as 'fake' | 'calle',

  calleApiKey: process.env.CALLE_API_KEY || '',
  calleApiBaseUrl:
    process.env.CALLE_API_BASE_URL || 'https://api.heycall-e.com',
  calleRequestTimeoutMs: int(process.env.CALLE_REQUEST_TIMEOUT_MS, 30000),
  // Shared secret embedded in the webhook path: CALL-E signs nothing, so the
  // path token is the only thing separating a real delivery from a forged one.
  calleWebhookToken: process.env.CALLE_WEBHOOK_TOKEN || '',
  // Full public URL CALL-E should call back, e.g.
  // https://<your-host>/speaking/webhook/<token>. Empty = rely on the
  // project-level webhook configured in the CALL-E dashboard.
  calleWebhookPublicUrl: process.env.CALLE_WEBHOOK_PUBLIC_URL || '',

  language: 'en',
  locale: 'en-US',
  region: 'US',

  maxCallMinutes: int(process.env.SPEAKING_MAX_CALL_MINUTES, 5),

  // A call counts as a real conversation only past both thresholds.
  minChargeSeconds: int(process.env.SPEAKING_MIN_CHARGE_SECONDS, 60),
  minUserTurns: int(process.env.SPEAKING_MIN_USER_TURNS, 2),
  // Fewer user turns than this and there is nothing to analyse.
  minAnalysisUserTurns: int(process.env.SPEAKING_MIN_ANALYSIS_USER_TURNS, 2),

  // Watchdog: a call still non-terminal after this is marked failed.
  callTimeoutSeconds: int(process.env.SPEAKING_CALL_TIMEOUT_SECONDS, 900),
  // If no webhook arrived this long after the request, poll CALL-E instead.
  webhookGraceSeconds: int(process.env.SPEAKING_WEBHOOK_GRACE_SECONDS, 120),
  schedulerEnabled: bool(process.env.SPEAKING_SCHEDULER_ENABLED, true),
  // While a call is active, GET /speaking/calls/:id re-reads CALL-E when the
  // stored snapshot is older than this, so the call screen moves in near real
  // time instead of waiting for the minute sweep.
  liveRefreshSeconds: int(process.env.SPEAKING_LIVE_REFRESH_SECONDS, 15),
}));
