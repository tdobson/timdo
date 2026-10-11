import {
  clearVoiceReview,
  createVoiceReview,
  loadVoiceReview,
  saveVoiceReview,
  type VoiceCommandResult,
} from './voiceTypes';

const result: VoiceCommandResult = {
  transcript: 'Add a fictional task',
  summary: 'Added a fictional task',
  proposedChanges: [
    {
      type: 'create',
      before: null,
      after: { project: 'Check the sample fixture' },
    },
  ],
};

const STORAGE_KEY = 'timdo:voice-review';

describe('voice review storage ownership', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('loads a stored review only for its owning account and clears it conditionally', () => {
    const review = createVoiceReview(result, 'account-a');

    expect(review).toMatchObject({ accountId: 'account-a', result });
    expect(review?.reviewId).toEqual(expect.any(String));
    expect(saveVoiceReview(review!)).toBe(true);
    expect(loadVoiceReview('account-a')).toEqual({ status: 'loaded', review });
    expect(loadVoiceReview('account-b')).toEqual({ status: 'different-account' });
    expect(clearVoiceReview({ accountId: 'account-a', reviewId: 'another-review' })).toBe(false);
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(clearVoiceReview({ accountId: 'account-a', reviewId: review!.reviewId })).toBe(true);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not assign an unowned legacy payload to the current account', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(result));

    expect(loadVoiceReview('account-b')).toEqual({ status: 'unowned' });
  });
});
