import type { SpeakingCallDto, SpeakingCallStatus } from 'types/dto/speaking';
import { ANALYTICS_EVENTS, type AnalyticsEvent } from 'utils/analytics';

/**
 * The single call screen renders one of these. Terminal states map onto the
 * end-of-call screens; `cancelling` is a local transition while the cancel
 * request is in flight.
 */
export type CallScreenState =
  | 'preparing'
  | 'calling'
  | 'wrappingUp'
  | 'cancelling'
  | 'cancelled'
  | 'couldNotStart'
  | 'missed'
  | 'partial'
  | 'noData'
  | 'completed';

export const isTerminalCallStatus = (status: SpeakingCallStatus): boolean =>
  status === 'completed' ||
  status === 'cancelled' ||
  status === 'missed' ||
  status === 'failed' ||
  status === 'partial';

/** Failed calls split into "never started" vs "answered but nothing usable". */
export const resolveCallScreenState = (
  call: Pick<SpeakingCallDto, 'status' | 'failureCode' | 'wrappingUp'>,
  cancelling = false,
): CallScreenState => {
  if (cancelling) return 'cancelling';
  // The line has dropped; CALL-E needs ~40s to hand us the transcript.
  if (call.wrappingUp && !isTerminalCallStatus(call.status)) return 'wrappingUp';
  switch (call.status) {
    case 'requested':
    case 'preparing':
      return 'preparing';
    case 'calling':
    case 'connected':
      return 'calling';
    case 'cancelled':
      return 'cancelled';
    case 'missed':
      return 'missed';
    case 'partial':
      return 'partial';
    case 'completed':
      return 'completed';
    case 'failed':
      return call.failureCode === 'insufficient_data' ? 'noData' : 'couldNotStart';
    default:
      return 'preparing';
  }
};

/** Whether the terminal screen shows "No call was used". */
export const showsNoCallUsed = (state: CallScreenState): boolean =>
  state === 'cancelled' || state === 'couldNotStart' || state === 'missed' || state === 'noData';

/** The conversation is worth opening from the terminal screen. */
export const hasSavedConversation = (state: CallScreenState): boolean =>
  state === 'completed' || state === 'partial';

/** Analytics event for a status transition, or null for non-events. */
export const analyticsEventForStatus = (status: SpeakingCallStatus): AnalyticsEvent | null => {
  switch (status) {
    case 'preparing':
      return ANALYTICS_EVENTS.CALL_PREPARING;
    case 'calling':
      return ANALYTICS_EVENTS.CALL_STARTED;
    case 'connected':
      return ANALYTICS_EVENTS.CALL_ANSWERED;
    case 'completed':
      return ANALYTICS_EVENTS.CALL_COMPLETED;
    case 'cancelled':
      return ANALYTICS_EVENTS.CALL_CANCELLED;
    case 'missed':
      return ANALYTICS_EVENTS.CALL_MISSED;
    case 'failed':
      return ANALYTICS_EVENTS.CALL_FAILED;
    case 'partial':
      return ANALYTICS_EVENTS.CALL_PARTIAL;
    default:
      return null;
  }
};
