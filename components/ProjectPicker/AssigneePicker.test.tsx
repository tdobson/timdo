import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import type { OrganisationMember } from '../../app/types/organisation.types';
import { render } from '../../test-utils/render';
import { AssigneePicker } from './AssigneePicker';

let mockMembers: OrganisationMember[] = [];

jest.mock('../../app/hooks/useOrganisationQueries', () => ({
  useOrganisationMembers: () => ({ data: mockMembers, isLoading: false }),
}));
jest.mock('../../app/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ userId: 'human-1' }),
}));

describe('AssigneePicker bot exclusion', () => {
  beforeEach(() => {
    mockMembers = [
      {
        id: 'member-1',
        orgId: 'org-1',
        userId: 'human-1',
        userName: 'Taylor Example',
        userEmail: 'taylor@example.test',
        role: 'member',
      },
      {
        id: 'member-2',
        orgId: 'org-1',
        userId: 'bot|fixture',
        userName: 'Forum watcher',
        userEmail: 'bot+fixture@bots.timdo.invalid',
        kind: 'bot',
        role: 'member',
      },
    ];
  });

  it('excludes bots and their synthetic email, including the current-value fallback', async () => {
    const Picker = AssigneePicker as React.ComponentType<any>;
    render(
      <Picker
        orgId="org-1"
        value="bot|fixture"
        currentName="Forum watcher"
        currentKind="bot"
        onChange={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('textbox', { name: 'Assignee' }));

    expect(await screen.findByRole('option', { name: /Taylor Example/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Forum watcher/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('bot+fixture@bots.timdo.invalid');
  });
});
