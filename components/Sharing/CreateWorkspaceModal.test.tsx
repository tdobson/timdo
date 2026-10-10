import React from 'react';
import { screen } from '@testing-library/react';
import { render } from '../../test-utils/render';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';

jest.mock('../../app/hooks/useSharingQueries', () => ({
  useCreateWorkspace: () => ({ mutate: jest.fn(), isPending: false }),
}));

describe('CreateWorkspaceModal', () => {
  it('uses a neutral workspace name example', () => {
    render(<CreateWorkspaceModal opened onClose={jest.fn()} />);

    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'e.g. Northstar Workshop');
  });
});
