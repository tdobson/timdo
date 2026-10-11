import { QueryClient } from '@tanstack/react-query';
import { clearOnAccountChange } from './Providers';

describe('account-scoped query cache', () => {
  it('clears cached task data when the active account changes', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['projects'], [{ id: 'task-a' }]);

    const nextAccount = clearOnAccountChange(queryClient, 'account-a', 'account-b');

    expect(nextAccount).toBe('account-b');
    expect(queryClient.getQueryData(['projects'])).toBeUndefined();
    queryClient.clear();
  });

  it('does not discard the first account cache while session identity is established', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['projects'], [{ id: 'task-a' }]);

    clearOnAccountChange(queryClient, undefined, 'account-a');

    expect(queryClient.getQueryData(['projects'])).toEqual([{ id: 'task-a' }]);
    queryClient.clear();
  });
});
