import { ConfigService } from '@nestjs/config';
import { CalleHttpProvider } from './calle.provider';
import { CalleApiError } from './calle.types';

const configWith = (values: Record<string, unknown>) =>
  ({
    get: jest.fn((key: string) => values[key]),
  }) as unknown as ConfigService;

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }) as unknown as Response;

const make = (config: ConfigService, fetchMock: jest.Mock) => {
  const provider = new CalleHttpProvider(config);
  provider.setFetch(fetchMock as unknown as typeof fetch);
  return provider;
};

describe('CalleHttpProvider', () => {
  const baseConfig = {
    'speaking.calleApiKey': 'calle_test_key',
    'speaking.calleApiBaseUrl': 'https://api.example.test/',
    'speaking.calleRequestTimeoutMs': 5000,
  };

  it('posts a create-call request with bearer auth and idempotency key', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(201, { id: 'call_1', status: 'queued' }));
    const provider = make(configWith(baseConfig), fetchMock);

    const result = await provider.createCall(
      { task: 'Call +14155550123', recipients: [{ phones: ['+14155550123'] }] },
      { idempotencyKey: 'key-1' },
    );

    expect(result).toEqual({ id: 'call_1', status: 'queued' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/calls');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer calle_test_key');
    expect(init.headers['Idempotency-Key']).toBe('key-1');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      task: 'Call +14155550123',
      recipients: [{ phones: ['+14155550123'] }],
    });
  });

  it('gets a call by id with the id URL-encoded', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: 'call/1' }));
    const provider = make(configWith(baseConfig), fetchMock);

    await provider.getCall('call/1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/calls/call%2F1');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('refuses to call without an API key', async () => {
    const fetchMock = jest.fn();
    const provider = make(
      configWith({ ...baseConfig, 'speaking.calleApiKey': '' }),
      fetchMock,
    );
    await expect(provider.getCall('x')).rejects.toMatchObject({
      name: 'CalleApiError',
      code: 'unauthorized',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a documented error envelope, including Retry-After', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(
        429,
        {
          error: {
            code: 'rate_limit_exceeded',
            message: 'Slow down',
            details: {},
          },
        },
        { 'Retry-After': '17' },
      ),
    );
    const provider = make(configWith(baseConfig), fetchMock);

    const error = await provider.getCall('x').catch((e) => e);
    expect(error).toBeInstanceOf(CalleApiError);
    expect(error.code).toBe('rate_limit_exceeded');
    expect(error.message).toBe('Slow down');
    expect(error.httpStatus).toBe(429);
    expect(error.retryAfterSeconds).toBe(17);
    expect(error.isTransient).toBe(true);
  });

  it('maps an undocumented error code to unknown and a 5xx to transient', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(503, { error: { code: 'weird_new_code', message: 'x' } }),
      );
    const provider = make(configWith(baseConfig), fetchMock);
    const error = await provider.getCall('x').catch((e) => e);
    expect(error.code).toBe('unknown');
    expect(error.isTransient).toBe(true);
  });

  it('handles a non-JSON error body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: { get: () => null },
      text: async () => '<html>bad gateway</html>',
    });
    const provider = make(configWith(baseConfig), fetchMock);
    const error = await provider.getCall('x').catch((e) => e);
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('CALL-E responded 502');
    expect(error.retryAfterSeconds).toBeNull();
  });

  it('treats an empty successful body as an internal error', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, undefined));
    const provider = make(configWith(baseConfig), fetchMock);
    await expect(provider.getCall('x')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('wraps transport failures as provider_unavailable', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const provider = make(configWith(baseConfig), fetchMock);
    const error = await provider.getCall('x').catch((e) => e);
    expect(error.code).toBe('provider_unavailable');
    expect(error.message).toContain('ECONNRESET');
  });

  it('reports a timeout distinctly', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockRejectedValue(abort);
    const provider = make(configWith(baseConfig), fetchMock);
    const error = await provider.getCall('x').catch((e) => e);
    expect(error.code).toBe('provider_unavailable');
    expect(error.message).toContain('timed out after 5000ms');
  });

  it('replays a timed-out create once with the same Idempotency-Key', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce(jsonResponse(200, { id: 'call_1' }));
    const provider = make(configWith(baseConfig), fetchMock);
    const created = await provider.createCall(
      { task: 't' },
      { idempotencyKey: 'key-1' },
    );
    expect(created.id).toBe('call_1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers['Idempotency-Key']).toBe('key-1');
    }
  });

  it('gives up after the second create timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockRejectedValue(abort);
    const provider = make(configWith(baseConfig), fetchMock);
    const error = await provider
      .createCall({ task: 't' }, { idempotencyKey: 'key-1' })
      .catch((e) => e);
    expect(error.timedOut).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not replay a create that failed without a timeout', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const provider = make(configWith(baseConfig), fetchMock);
    await expect(
      provider.createCall({ task: 't' }, { idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ timedOut: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default base URL and timeout', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: 'x' }));
    const provider = make(
      configWith({ 'speaking.calleApiKey': 'k' }),
      fetchMock,
    );
    await provider.getCall('x');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.heycall-e.com/v1/calls/x',
    );
  });
});

describe('CalleApiError', () => {
  it('flags only retry-worthy codes as transient', () => {
    const make = (code: string, httpStatus = 400) =>
      new CalleApiError({ code, message: 'm', httpStatus });
    expect(make('rate_limit_exceeded').isTransient).toBe(true);
    expect(make('provider_unavailable').isTransient).toBe(true);
    expect(make('internal_error').isTransient).toBe(true);
    expect(make('invalid_phone').isTransient).toBe(false);
    expect(make('insufficient_balance').isTransient).toBe(false);
    expect(make('unknown_thing', 500).isTransient).toBe(true);
  });
});
