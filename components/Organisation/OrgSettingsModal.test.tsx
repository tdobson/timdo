import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import {
  useInviteMember,
  useOrganisation,
  useOrganisationInvites,
  useOrganisationMembers,
  useRemoveMember,
  useUpdateMemberRole,
} from '../../app/hooks/useOrganisationQueries';
import { theme } from '../../theme';
import { OrgSettingsModal } from './OrgSettingsModal';

jest.mock('../../app/hooks/useOrganisationQueries', () => ({
  useOrganisation: jest.fn(),
  useOrganisationMembers: jest.fn(),
  useOrganisationInvites: jest.fn(),
  useInviteMember: jest.fn(),
  useUpdateMemberRole: jest.fn(),
  useRemoveMember: jest.fn(),
  useSearchUsers: jest.fn().mockReturnValue({ data: [], isLoading: false }),
}));

const mockOrg = {
  id: 'org-123',
  name: 'Northstar Workshop',
  slug: 'northstar-workshop',
  createdBy: 'user-owner',
};

const mockMembers = [
  {
    id: 'm-1',
    orgId: 'org-123',
    userId: 'user-owner',
    role: 'owner' as const,
    userName: 'Casey Example',
    userEmail: 'casey@example.com',
  },
  {
    id: 'm-2',
    orgId: 'org-123',
    userId: 'user-admin',
    role: 'admin' as const,
    userName: 'Jordan Example',
    userEmail: 'jordan@example.com',
  },
  {
    id: 'm-3',
    orgId: 'org-123',
    userId: 'user-member',
    role: 'member' as const,
    userName: 'Alex Example',
    userEmail: 'alex@example.com',
  },
];

const mockInvites = [
  {
    id: 'inv-1',
    orgId: 'org-123',
    email: 'invite@example.com',
    role: 'member' as const,
    token: 'tok-abc',
    invitedBy: 'user-owner',
    expiresAt: '2026-09-20T00:00:00Z',
  },
];

describe('OrgSettingsModal', () => {
  const onClose = jest.fn();
  const mockInviteMutate = jest.fn().mockResolvedValue({});
  const mockUpdateRoleMutate = jest.fn().mockResolvedValue({});
  const mockRemoveMemberMutate = jest.fn().mockResolvedValue({});

  beforeEach(() => {
    jest.clearAllMocks();
    (useOrganisation as jest.Mock).mockReturnValue({
      data: mockOrg,
      isLoading: false,
    });
    (useOrganisationMembers as jest.Mock).mockReturnValue({
      data: mockMembers,
      isLoading: false,
    });
    (useOrganisationInvites as jest.Mock).mockReturnValue({
      data: mockInvites,
      isLoading: false,
    });
    (useInviteMember as jest.Mock).mockReturnValue({
      mutateAsync: mockInviteMutate,
      isPending: false,
    });
    (useUpdateMemberRole as jest.Mock).mockReturnValue({
      mutateAsync: mockUpdateRoleMutate,
    });
    (useRemoveMember as jest.Mock).mockReturnValue({
      mutateAsync: mockRemoveMemberMutate,
    });
  });

  const renderModal = (currentUserId = 'user-owner') =>
    render(
      <MantineProvider theme={theme}>
        <OrgSettingsModal opened onClose={onClose} orgId="org-123" currentUserId={currentUserId} />
      </MantineProvider>
    );

  it('renders organisation title and member list', () => {
    renderModal('user-owner');
    expect(screen.getByText(/organisation settings: northstar workshop/i)).toBeInTheDocument();
    expect(screen.getByText('Casey Example')).toBeInTheDocument();
    expect(screen.getByText('Jordan Example')).toBeInTheDocument();
    expect(screen.getByText('Alex Example')).toBeInTheDocument();
  });

  it('displays owner badge for the creator/owner', () => {
    renderModal('user-owner');
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('allows owner to remove a non-owner member', async () => {
    renderModal('user-owner');
    const removeBtn = screen.getByTestId('remove-member-user-member');
    expect(removeBtn).toBeInTheDocument();
    await userEvent.click(removeBtn);
    expect(mockRemoveMemberMutate).toHaveBeenCalledWith('user-member');
  });

  it('shows pending invites tab content', async () => {
    renderModal('user-owner');
    const invitesTab = screen.getByRole('tab', { name: /pending invites/i });
    await userEvent.click(invitesTab);

    expect(screen.getByText('invite@example.com')).toBeInTheDocument();
    expect(screen.getByText('Pending Invite')).toBeInTheDocument();
  });

  it('submits direct email invite', async () => {
    renderModal('user-owner');
    const emailInput = screen.getByTestId('invite-email-input');
    const sendBtn = screen.getByTestId('invite-submit-btn');

    await userEvent.type(emailInput, 'newmember@example.com');
    await userEvent.click(sendBtn);

    expect(mockInviteMutate).toHaveBeenCalledWith({
      email: 'newmember@example.com',
      role: 'member',
    });
  });
});
