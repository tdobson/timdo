import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Project } from '../../app/types/project.types';
import { render } from '../../test-utils';
import { EditProjectModal } from './EditProjectModal';

jest.mock('../FeatureCard/ProjectUpdatesTimeline', () => ({
  ProjectUpdatesTimeline: () => <div data-testid="notes-timeline" />,
}));

const thread = '1a11f9b5ec8c2b2f';
const project: Project = {
  id: 'task-1',
  project: 'Broken offer page',
  reason: 'Members cannot see offers',
  notes: undefined,
  status: 'do',
  priority: 5,
  size: '***',
  userId: 'user-1',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  statusLastChangedOn: '2026-10-01T00:00:00.000Z',
  gmailThreadId: thread,
  refs: [
    {
      id: 'ref-1',
      taskId: 'task-1',
      role: 'source',
      kind: 'forum.post',
      ref: '4411',
      canonical: 'forum.post:4411',
      url: null,
      label: null,
      displayLabel: 'forum.post:4411',
      createdById: 'user-1',
      createdByName: 'Robin Fairweather',
      createdAt: '2026-10-01T00:00:00.000Z',
      canDelete: true,
    },
  ],
};

function save(gmailThreadId?: string) {
  const onSave = jest.fn();
  render(<EditProjectModal opened onClose={jest.fn()} project={project} onSave={onSave} />);
  if (gmailThreadId !== undefined) {
    fireEvent.change(screen.getByLabelText(/gmail thread id/i), {
      target: { value: gmailThreadId },
    });
  }
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  return onSave;
}

describe('EditProjectModal', () => {
  it('never sends refs (PUT refuses them) and leaves an unedited thread out', async () => {
    const onSave = save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const sent = onSave.mock.calls[0][0];
    expect(sent).not.toHaveProperty('refs');
    expect(sent).not.toHaveProperty('gmailThreadId');
    expect(sent).toMatchObject({ id: 'task-1', project: 'Broken offer page' });
  });

  it('sends the thread when it was edited', async () => {
    const onSave = save(' 2b22f9b5ec8c2b2f ');
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ gmailThreadId: '2b22f9b5ec8c2b2f' });
  });
});
