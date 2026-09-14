import type { CalleCallTask, CalleCreateCallRequest } from './calle.types';

export const CALLE_PROVIDER = Symbol('CALLE_PROVIDER');

export interface CalleCreateCallOptions {
  /** Stable key so a retried request returns the original call. */
  idempotencyKey: string;
}

/**
 * The slice of CALL-E we depend on. Two implementations: the HTTP client and
 * an in-process fake that replays a scripted lifecycle (see fake-calle.provider).
 */
export interface CalleProvider {
  createCall(
    request: CalleCreateCallRequest,
    options: CalleCreateCallOptions,
  ): Promise<CalleCallTask>;
  getCall(callId: string): Promise<CalleCallTask>;
}
