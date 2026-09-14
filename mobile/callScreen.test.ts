import {
  analyticsEventForStatus,
  hasSavedConversation,
  isTerminalCallStatus,
  resolveCallScreenState,
  showsNoCallUsed,
} from './callScreen';

describe('callScreen helpers', () => {
  it.each([
    ['requested', null, 'preparing'],
    ['preparing', null, 'preparing'],
    ['calling', null, 'calling'],
    ['connected', null, 'calling'],
    ['cancelled', null, 'cancelled'],
    ['missed', 'no_answer', 'missed'],
    ['partial', 'connection_lost', 'partial'],
    ['completed', null, 'completed'],
    ['failed', 'insufficient_data', 'noData'],
    ['failed', 'create_failed:invalid_phone', 'couldNotStart'],
    ['failed', 'timeout', 'couldNotStart'],
  ] as const)('%s / %s → %s', (status, failureCode, expected) => {
    expect(resolveCallScreenState({ status, failureCode })).toBe(expected);
  });

  it('shows wrapping up once the line dropped, until the call settles', () => {
    expect(
      resolveCallScreenState({ status: 'connected', failureCode: null, wrappingUp: true }),
    ).toBe('wrappingUp');
    expect(
      resolveCallScreenState({ status: 'completed', failureCode: null, wrappingUp: true }),
    ).toBe('completed');
    expect(resolveCallScreenState({ status: 'connected', failureCode: null })).toBe('calling');
  });

  it('shows cancelling while the request is in flight', () => {
    expect(resolveCallScreenState({ status: 'calling', failureCode: null }, true)).toBe(
      'cancelling',
    );
  });

  it('knows terminal statuses', () => {
    expect(isTerminalCallStatus('completed')).toBe(true);
    expect(isTerminalCallStatus('failed')).toBe(true);
    expect(isTerminalCallStatus('calling')).toBe(false);
  });

  it('shows "no call used" only where no conversation was kept', () => {
    expect(showsNoCallUsed('cancelled')).toBe(true);
    expect(showsNoCallUsed('missed')).toBe(true);
    expect(showsNoCallUsed('noData')).toBe(true);
    expect(showsNoCallUsed('couldNotStart')).toBe(true);
    expect(showsNoCallUsed('partial')).toBe(false);
    expect(showsNoCallUsed('completed')).toBe(false);
  });

  it('offers the conversation for completed and partial calls', () => {
    expect(hasSavedConversation('completed')).toBe(true);
    expect(hasSavedConversation('partial')).toBe(true);
    expect(hasSavedConversation('missed')).toBe(false);
  });

  it('maps statuses to analytics events', () => {
    expect(analyticsEventForStatus('connected')).toBe('call_answered');
    expect(analyticsEventForStatus('failed')).toBe('call_failed');
    expect(analyticsEventForStatus('requested')).toBeNull();
  });
});
