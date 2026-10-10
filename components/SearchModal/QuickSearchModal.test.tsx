import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTaskSearch } from '../../app/hooks/useSearchQueries';
import { render } from '../../test-utils/render';
import { QuickSearchModal } from './QuickSearchModal';

jest.mock('../../app/hooks/useSearchQueries', () => ({
  useTaskSearch: jest.fn(),
}));
jest.mock('../../app/hooks/useProjectQueries', () => ({
  useProjects: () => ({ data: [] }),
}));
jest.mock('../../app/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ userId: 'user-1' }),
}));

const result = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  shortId: id.slice(0, 8),
  title,
  status: 'do',
  priority: 5,
  score: 1,
  projectName: 'Acme Solar',
  ...extra,
});

describe('QuickSearchModal', () => {
  beforeEach(() => {
    (useTaskSearch as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it('says that pasting a link finds the tasks carrying it', () => {
    render(<QuickSearchModal opened onClose={jest.fn()} />);

    expect(screen.getByText(/paste a link to find the tasks that carry it/i)).toBeInTheDocument();
  });

  it('flags exact link matches and explains what the paste was read as', async () => {
    const user = userEvent.setup();
    (useTaskSearch as jest.Mock).mockReturnValue({
      data: [
        result('3f2a91c0aaaa', 'Broken offer page', { matchedRef: true }),
        result('77aa0000bbbb', 'Mentions the issue in notes', { snippet: 'see issue 12' }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<QuickSearchModal opened onClose={jest.fn()} />);
    await user.click(screen.getByRole('textbox', { name: 'Search tasks' }));
    await user.paste('https://github.com/acme/widgets/issues/12');

    expect(screen.getByTestId('search-ref')).toHaveTextContent(
      'Tasks linked to GitHub issue acme/widgets#12 come first, done ones included'
    );
    const badges = screen.getAllByTestId('search-matched-ref');
    expect(badges).toHaveLength(1);
    expect(badges[0].closest('a')).toHaveAttribute('href', '/tasks/3f2a91c0aaaa');
  });

  it('treats ordinary words as a normal search', async () => {
    const user = userEvent.setup();
    render(<QuickSearchModal opened onClose={jest.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Search tasks' }), 'inverter fault');

    expect(screen.queryByTestId('search-ref')).not.toBeInTheDocument();
  });
});
