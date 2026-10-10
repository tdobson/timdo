import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { useSearchUsers } from '../../app/hooks/useOrganisationQueries';
import { theme } from '../../theme';
import { MemberAutocomplete } from './MemberAutocomplete';

jest.mock('../../app/hooks/useOrganisationQueries', () => ({
  useSearchUsers: jest.fn(),
}));

const mockSearchResults = [
  {
    id: 'user-1',
    name: 'Casey Example',
    email: 'casey@example.com',
    isMember: true,
    role: 'admin' as const,
  },
  {
    id: 'user-2',
    name: 'Jordan Example',
    email: 'jordan@example.com',
    isMember: false,
  },
];

describe('MemberAutocomplete', () => {
  const onSelectExistingUser = jest.fn();
  const onSelectInviteEmail = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useSearchUsers as jest.Mock).mockImplementation((_orgId: string, query: string) => ({
      data: query
        ? mockSearchResults.filter((user) =>
            `${user.name} ${user.email}`.toLowerCase().includes(query.toLowerCase())
          )
        : [],
      isLoading: false,
    }));
  });

  const renderComponent = () =>
    render(
      <MantineProvider theme={theme}>
        <MemberAutocomplete
          orgId="org-123"
          onSelectExistingUser={onSelectExistingUser}
          onSelectInviteEmail={onSelectInviteEmail}
        />
      </MantineProvider>
    );

  it('renders input field with placeholder', () => {
    renderComponent();
    expect(
      screen.getByPlaceholderText('Search user by name/email or enter new email...')
    ).toBeInTheDocument();
  });

  it('shows autocomplete search results when typing', async () => {
    renderComponent();
    const input = screen.getByPlaceholderText('Search user by name/email or enter new email...');
    await userEvent.type(input, 'jordan');

    await waitFor(() => {
      expect(useSearchUsers).toHaveBeenLastCalledWith('org-123', 'jordan');
      expect(screen.getByText('Jordan Example')).toBeInTheDocument();
      expect(screen.getByText('jordan@example.com')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('user-option-user-1')).not.toBeInTheDocument();
  });

  it('invokes onSelectExistingUser when clicking a non-member search result', async () => {
    renderComponent();
    const input = screen.getByPlaceholderText('Search user by name/email or enter new email...');
    await userEvent.type(input, 'jordan');

    await waitFor(() => {
      expect(screen.getByText('Jordan Example')).toBeInTheDocument();
    });

    const userOption = screen.getByTestId('user-option-user-2');
    await userEvent.click(userOption);

    expect(onSelectExistingUser).toHaveBeenCalledWith(mockSearchResults[1]);
  });

  it('offers email invitation option for new email addresses', async () => {
    (useSearchUsers as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderComponent();
    const input = screen.getByPlaceholderText('Search user by name/email or enter new email...');
    await userEvent.type(input, 'newperson@company.com');

    await waitFor(() => {
      expect(screen.getByTestId('invite-email-option')).toBeInTheDocument();
    });

    const inviteOption = screen.getByTestId('invite-email-option');
    await userEvent.click(inviteOption);

    expect(onSelectInviteEmail).toHaveBeenCalledWith('newperson@company.com');
  });
});
