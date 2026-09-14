# Tanaroom × CALL-E: speaking practice over a real phone call

Tanaroom is a language-learning app. This repository holds the part of it that
talks to CALL-E: a learner taps "Request a call", Tanar (the app's fox tutor)
calls their phone, they talk in English for a few minutes, and the transcript
comes back into the app for feedback.

The code is lifted from a private monorepo (NestJS backend, React Native app).
It is an excerpt, not a standalone package: Prisma models, the observability
layer, auth guards and the post-call analysis are referenced but not included.
Tests sit next to the code the way they do in the main repo and run there.

## How a call flows

1. The app posts `POST /speaking/calls`. The backend creates a call row in
   status `requested` and answers right away. CALL-E can take 20 to 45 seconds
   to accept a call, longer than the app's request timeout, so the placement
   runs in the background (`speaking-call.service.ts`, `placeCall`).
2. The backend calls `POST /v1/calls` with the task text
   (`speaking-call-task.prompt.ts`), a `result_schema`, our own ids in
   `metadata`, the `webhook_url` and an `Idempotency-Key`. A timed-out create
   is replayed once with the same key, because CALL-E has been seen to place
   the call and still exceed the timeout (`calle.provider.ts`).
3. While the call is live the app polls `GET /speaking/calls/:id` every two
   seconds. The backend re-reads `GET /v1/calls/{id}` at most every 15 seconds
   and maps the recipient status to `preparing`, `calling` or `connected`
   (`call-status.util.ts`, `mapInProgressStatus`). When the attempt already
   has `completed_at` but the task is not terminal, the call is reported as
   `wrappingUp`, so the app can show "conversation ended, preparing your
   feedback" instead of a live-call screen.
4. The terminal result arrives through the webhook
   (`speaking-webhook.controller.ts`, `speaking-webhook.service.ts`) or, if it
   never does, through the minute sweep (`speaking.scheduler.ts`). The
   snapshot is collapsed into `completed`, `partial`, `missed`, `failed` or
   `cancelled` (`resolveTerminalOutcome`) and the transcript is stored.
5. The app maps the call status to one screen state (`mobile/callScreen.ts`).

## Webhook handling

CALL-E does not sign webhook bodies. What we do instead:

- the shared token in the webhook path is compared in constant time;
- the `CALL-E-Event-Id` header must match the event id in the body;
- every event id goes through a two-phase idempotency table, so retries and
  concurrent deliveries settle a call once;
- before settling, the call is re-read from `GET /v1/calls/{id}`; the body is
  used only if that read fails, and the fallback is recorded;
- the body is accepted untyped and validated by hand
  (`webhook-parser.util.ts`), so a new upstream field never turns into a 400
  that makes CALL-E retry forever.

## Things worth knowing about CALL-E (API v0.7.0)

- There is no cancel endpoint. A user-side cancel only marks our row; if the
  call connects anyway and a real conversation happens, the row is revived
  as a real call (`applyTerminalTask`).
- The task-level `status` stayed `queued` through a whole live lesson. The
  recipient status (`dialing`, `in_progress`) is what the call screen needs.
- The terminal event comes 30 to 40 seconds after the line drops; that is
  the `wrappingUp` window above.
- Attempt-level `failure_code` values are not enumerated in the OpenAPI
  file; `isMissedFailureCode` treats anything that looks like "not picked up"
  as a missed call rather than a failure.
- CALL-E refuses tasks that read out verification codes, so phone
  verification uses SMS, not CALL-E.

## Layout

```
backend/
  config/speaking.config.ts              env-driven settings
  common/utils/webhook-idempotency.ts    two-phase claim/finish for webhook events
  common/decorators/public_decorator.ts  marks the webhook route as unauthenticated
  speaking/
    providers/calle.types.ts             wire types and CalleApiError
    providers/calle.provider.ts          HTTP client, timeout, idempotent replay
    providers/calle.provider.interface.ts
    prompts/speaking-call-task.prompt.ts task text and result_schema
    utils/call-status.util.ts            snapshot → our statuses
    utils/transcript.util.ts             turns → transcript messages
    utils/webhook-parser.util.ts         runtime guard for the webhook body
    services/speaking-call.service.ts    request, place, refresh, settle, sweep
    services/speaking-webhook.service.ts token, event id, idempotency, re-read
    speaking-webhook.controller.ts
    speaking.scheduler.ts                minute sweep
mobile/
  callScreen.ts                          call status → screen state
```

Import paths such as `prisma/prisma.service` and `modules/observability/*`
resolve inside the monorepo and point at code that is not part of this
excerpt.

## Configuration

See `.env.example`. The API key and the webhook token never leave the
backend; the app talks only to our own API.
