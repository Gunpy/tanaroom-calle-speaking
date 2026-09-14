// modules
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// types
import type {
  CalleProvider,
  CalleCreateCallOptions,
} from './calle.provider.interface';
import {
  CalleApiError,
  type CalleApiErrorEnvelope,
  type CalleCallTask,
  type CalleCreateCallRequest,
} from './calle.types';

type FetchLike = typeof fetch;

/**
 * Thin HTTP client for the CALL-E Developer API (v0.7.0). The API key never
 * leaves this process; React Native talks only to our backend.
 *
 * `setFetch` lets unit tests exercise request shaping, error mapping and
 * retry-after parsing without the network fuse tripping.
 */
@Injectable()
export class CalleHttpProvider implements CalleProvider {
  private readonly logger = new Logger(CalleHttpProvider.name);
  private fetchImpl: FetchLike = (...args) => fetch(...args);

  constructor(private readonly config: ConfigService) {}

  /** Test seam: swap the transport. */
  setFetch(fetchImpl: FetchLike): void {
    this.fetchImpl = fetchImpl;
  }

  async createCall(
    request: CalleCreateCallRequest,
    options: CalleCreateCallOptions,
  ): Promise<CalleCallTask> {
    const send = () =>
      this.request<CalleCallTask>('POST', '/v1/calls', {
        body: request,
        headers: { 'Idempotency-Key': options.idempotencyKey },
      });
    try {
      return await send();
    } catch (error) {
      // CALL-E has been seen to create the call and still exceed our timeout;
      // the Idempotency-Key makes one replay return that call instead of dialing twice.
      if (!(error instanceof CalleApiError) || !error.timedOut) {
        throw error;
      }
      this.logger.warn(
        `CALL-E create call timed out, replaying with key ${options.idempotencyKey}`,
      );
      return send();
    }
  }

  async getCall(callId: string): Promise<CalleCallTask> {
    return this.request<CalleCallTask>(
      'GET',
      `/v1/calls/${encodeURIComponent(callId)}`,
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const apiKey = this.config.get<string>('speaking.calleApiKey') || '';
    if (!apiKey) {
      throw new CalleApiError({
        code: 'unauthorized',
        message: 'CALLE_API_KEY is not configured',
        httpStatus: 0,
      });
    }

    const baseUrl = (
      this.config.get<string>('speaking.calleApiBaseUrl') ||
      'https://api.heycall-e.com'
    ).replace(/\/+$/, '');
    const timeoutMs =
      this.config.get<number>('speaking.calleRequestTimeoutMs') || 30000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as { name?: string })?.name === 'AbortError';
      throw new CalleApiError({
        code: 'provider_unavailable',
        message: aborted
          ? `CALL-E request timed out after ${timeoutMs}ms`
          : `CALL-E request failed: ${error instanceof Error ? error.message : String(error)}`,
        httpStatus: 0,
        timedOut: aborted,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const envelope = parsed as Partial<CalleApiErrorEnvelope> | null;
      const code = envelope?.error?.code ?? 'unknown';
      const message =
        envelope?.error?.message ?? `CALL-E responded ${response.status}`;
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = retryAfterHeader
        ? parseInt(retryAfterHeader, 10)
        : NaN;
      this.logger.warn(
        `CALL-E ${method} ${path} → ${response.status} ${code}: ${message}`,
      );
      throw new CalleApiError({
        code,
        message,
        httpStatus: response.status,
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
      });
    }

    if (parsed === null) {
      throw new CalleApiError({
        code: 'internal_error',
        message: 'CALL-E returned an empty or non-JSON body',
        httpStatus: response.status,
      });
    }

    return parsed as T;
  }
}
