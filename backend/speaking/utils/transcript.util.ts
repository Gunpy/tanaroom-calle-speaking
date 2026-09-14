import { SpeakingSpeaker } from '@prisma/client';
import type {
  CalleAttempt,
  CalleTranscriptTurn,
} from '../providers/calle.types';

export interface TranscriptMessageDraft {
  speaker: SpeakingSpeaker;
  text: string;
  offsetSeconds: number;
  order: number;
}

/**
 * CALL-E labels the agent `bot`; in Tanaroom that voice is Tanar. Turns with
 * an `unknown` speaker are dropped: attributing them to the learner would
 * feed the mistake analysis text they may never have said, and attributing
 * them to Tanar would hide their own words from them.
 */
export function turnsToMessages(
  turns: CalleTranscriptTurn[],
): TranscriptMessageDraft[] {
  const messages: TranscriptMessageDraft[] = [];
  for (const turn of turns) {
    const text = (turn.text ?? '').trim();
    if (!text) continue;
    if (turn.speaker === 'unknown') continue;
    messages.push({
      speaker:
        turn.speaker === 'bot' ? SpeakingSpeaker.tanar : SpeakingSpeaker.user,
      text,
      offsetSeconds: Math.max(0, Math.round(turn.offset_seconds ?? 0)),
      order: messages.length,
    });
  }
  return messages;
}

export function countUserTurns(messages: TranscriptMessageDraft[]): number {
  return messages.filter((m) => m.speaker === SpeakingSpeaker.user).length;
}

/**
 * The attempt that actually reached the phone: the last one with a
 * transcript, else the last one that started, else the last one at all.
 */
export function pickPrimaryAttempt(
  attempts: CalleAttempt[] | undefined,
): CalleAttempt | null {
  if (!attempts?.length) return null;
  const withTranscript = [...attempts]
    .reverse()
    .find((a) => a.transcript_turns?.length > 0);
  if (withTranscript) return withTranscript;
  const started = [...attempts].reverse().find((a) => a.started_at);
  return started ?? attempts[attempts.length - 1];
}

/**
 * Connected duration in whole seconds. Prefers wall-clock timestamps; falls
 * back to the last transcript offset when CALL-E omits `completed_at`.
 */
export function computeDurationSeconds(
  attempt: CalleAttempt | null,
): number | null {
  if (!attempt) return null;
  if (attempt.started_at && attempt.completed_at) {
    const start = Date.parse(attempt.started_at);
    const end = Date.parse(attempt.completed_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return Math.round((end - start) / 1000);
    }
  }
  const turns = attempt.transcript_turns ?? [];
  if (turns.length) {
    const last = turns[turns.length - 1];
    return Math.max(0, Math.round(last.offset_seconds ?? 0));
  }
  return null;
}

/** Plain text rendering for LLM prompts: "Tanar: …\nYou: …". */
export function renderTranscript(
  messages: Array<{ speaker: SpeakingSpeaker; text: string; order: number }>,
): string {
  return messages
    .map(
      (m) =>
        `[${m.order}] ${m.speaker === SpeakingSpeaker.tanar ? 'Tanar' : 'Learner'}: ${m.text}`,
    )
    .join('\n');
}
