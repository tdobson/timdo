import React from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as refQueries from '../../app/hooks/useRefQueries';
import type { Project, RefView } from '../../app/types/project.types';
import { render } from '../../test-utils/render';
import { PARSE_ERROR } from '../../workers/src/lib/refs';
import { PEOPLE_BY_ID_HINT, TaskRefs } from './TaskRefs';

jest.mock('../../app/hooks/useRefQueries', () => ({
  ...jest.requireActual('../../app/hooks/useRefQueries'),
  useAddRef: jest.fn(),
  useRemoveRef: jest.fn(),
}));

function refView(overrides: Partial<RefView> & Pick<RefView, 'id'>): RefView {
  return {
    taskId: 'task-1',
    role: 'link',
    kind: 'github.issue',
    ref: 'acme/widgets#12',
    canonical: 'github.issue:acme/widgets#12',
    url: 'https://github.com/acme/widgets/issues/12',
    label: null,
    displayLabel: 'GitHub issue acme/widgets#12',
    createdById: 'user-1',
    createdByName: 'Robin Fairweather',
    createdAt: '2026-10-09T10:00:00.000Z',
    canDelete: true,
    ...overrides,
  };
}

const source = refView({
  id: 'r-source',
  role: 'source',
  kind: 'forum.post',
  ref: '4411',
  canonical: 'forum.post:4411',
  url: null,
  displayLabel: 'forum.post:4411',
});
const reporter = refView({
  id: 'r-reporter',
  role: 'reported_by',
  kind: 'acme.member',
  ref: '123456',
  canonical: 'acme.member:123456',
  url: null,
  label: 'Member on the forum',
  displayLabel: 'Member on the forum',
});
const about = refView({
  id: 'r-about',
  role: 'about',
  kind: 'acme.member',
  ref: '998',
  canonical: 'acme.member:998',
  url: null,
  displayLabel: 'acme.member:998',
});
const issue = refView({ id: 'r-issue' });

const baseTask: Project = {
  id: 'task-1',
  userId: 'user-1',
  project: 'Broken offer page',
  status: 'do',
  priority: 5,
  size: '**',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  refs: [],
};

describe('TaskRefs', () => {
  let addMutate: jest.Mock;
  let removeMutate: jest.Mock;

  beforeEach(() => {
    addMutate = jest.fn();
    removeMutate = jest.fn();
    (refQueries.useAddRef as jest.Mock).mockReturnValue({ mutate: addMutate });
    (refQueries.useRemoveRef as jest.Mock).mockReturnValue({ mutate: removeMutate });
  });

  const renderRefs = (refs: RefView[], canEdit = true) =>
    render(<TaskRefs task={{ ...baseTask, refs }} canEdit={canEdit} />);

  it('groups links by role: Source, About, Reported by, then Link', () => {
    // Deliberately out of order: the component sorts
    renderRefs([issue, reporter, about, source]);

    expect(screen.getByText('Links')).toBeInTheDocument();
    const groups = screen.getAllByTestId(/^ref-group-/).map((g) => g.dataset.testid);
    expect(groups).toEqual([
      'ref-group-source',
      'ref-group-about',
      'ref-group-reported_by',
      'ref-group-link',
    ]);
    expect(
      within(screen.getByTestId('ref-group-reported_by')).getByText('Reported by')
    ).toBeVisible();
    // A label stands in for the id, and nothing about the person beyond what was typed
    expect(screen.getByText('Member on the forum')).toBeInTheDocument();
  });

  it('opens links with a URL in a new tab and shows the rest as text', () => {
    renderRefs([issue, source]);

    const link = screen.getByRole('link', { name: /github issue acme\/widgets#12/i });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/widgets/issues/12');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: /forum\.post/ })).not.toBeInTheDocument();
    expect(screen.getByText('forum.post:4411')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy forum.post:4411' })).toBeInTheDocument();
  });

  it('marks bot creators in the accessible ref tooltip', async () => {
    renderRefs(
      [refView({ id: 'r-bot', createdByName: 'Forum watcher', createdByKind: 'bot' })],
      false
    );

    await userEvent.hover(screen.getByRole('link', { name: /github issue acme\/widgets#12/i }));

    await waitFor(() => expect(screen.getByText(/added by Forum watcher \[bot\]/)).toBeVisible());
  });

  it('announces bot authorship when focusing a reference without a URL', async () => {
    const botRef = refView({
      id: 'r-bot',
      kind: 'acme.member',
      ref: '123456',
      canonical: 'acme.member:123456',
      url: null,
      displayLabel: 'Forum member',
      createdByName: 'Forum watcher',
      createdByKind: 'bot',
    });
    renderRefs([botRef], false);

    const reference = screen.getByRole('group', {
      name: 'acme.member:123456, added by Forum watcher [bot]',
    });
    expect(reference).toHaveAttribute('tabindex', '0');
    await userEvent.tab();
    expect(reference).toHaveFocus();
  });

  it('collapses a long group to three and "and N more"', async () => {
    const user = userEvent.setup();
    const links = [1, 2, 3, 4, 5].map((n) =>
      refView({
        id: `r-${n}`,
        ref: `acme/widgets#${n}`,
        canonical: `github.issue:acme/widgets#${n}`,
        displayLabel: `GitHub issue acme/widgets#${n}`,
        createdAt: `2026-10-0${n}T00:00:00.000Z`,
      })
    );
    renderRefs(links);

    expect(screen.getAllByTestId('ref-chip')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'and 2 more' }));
    expect(screen.getAllByTestId('ref-chip')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByTestId('ref-chip')).toHaveLength(3);
  });

  it('offers only a quiet "Add a link" when there are none', () => {
    renderRefs([]);

    expect(screen.queryByText('Links')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a link' })).toBeInTheDocument();
  });

  it('renders nothing for a viewer when there are no links', () => {
    renderRefs([], false);

    expect(screen.queryByTestId('task-refs')).not.toBeInTheDocument();
  });

  it('shows links to viewers without add or remove controls', () => {
    renderRefs([issue, source], false);

    expect(screen.getAllByTestId('ref-chip')).toHaveLength(2);
    expect(screen.queryByTestId('ref-remove')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a link' })).not.toBeInTheDocument();
  });

  it('hides remove on links the API says I cannot delete', () => {
    renderRefs([{ ...issue, canDelete: false }]);

    expect(screen.queryByTestId('ref-remove')).not.toBeInTheDocument();
  });

  it('removes a link by its id', async () => {
    const user = userEvent.setup();
    renderRefs([issue]);

    await user.click(
      screen.getByRole('button', { name: 'Remove GitHub issue acme/widgets#12 (Link)' })
    );

    expect(removeMutate).toHaveBeenCalledWith({ taskId: 'task-1', refId: 'r-issue' });
  });

  it('previews what was pasted, adds it on Enter, then clears and keeps focus', async () => {
    const user = userEvent.setup();
    renderRefs([]);

    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    const input = screen.getByRole('textbox', { name: 'Link to add' });
    expect(input).toHaveFocus();

    await user.type(input, 'https://github.com/acme/widgets/pull/7?tab=files');
    expect(screen.getByTestId('add-ref-preview')).toHaveTextContent(
      'GitHub PR acme/widgets#7 · github.pr:acme/widgets#7'
    );
    expect(screen.getByTestId('add-ref-submit')).toBeEnabled();

    await user.keyboard('{Enter}');

    expect(addMutate).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        input: { ref: 'https://github.com/acme/widgets/pull/7?tab=files', role: 'link' },
      },
      expect.any(Object)
    );
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
  });

  it('shows the parser sentence and disables Add for input it cannot read', async () => {
    const user = userEvent.setup();
    renderRefs([]);

    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.type(screen.getByRole('textbox', { name: 'Link to add' }), 'just some words');

    expect(screen.getByTestId('add-ref-error')).toHaveTextContent(PARSE_ERROR);
    expect(screen.getByTestId('add-ref-submit')).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(addMutate).not.toHaveBeenCalled();
  });

  it('will not add the same link twice in the same role', async () => {
    const user = userEvent.setup();
    renderRefs([issue]);

    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Link to add' }),
      'github.issue:acme/widgets#12'
    );

    expect(screen.getByTestId('add-ref-preview')).toHaveTextContent('already on this task as Link');
    expect(screen.getByTestId('add-ref-submit')).toBeDisabled();
  });

  it('sends the chosen role and label, with a reminder to record people by id', async () => {
    const user = userEvent.setup();
    renderRefs([]);

    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.type(screen.getByRole('textbox', { name: 'Link to add' }), 'acme.member:123456');
    await user.click(screen.getByRole('textbox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: 'Reported by' }));
    expect(screen.getByText(PEOPLE_BY_ID_HINT)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Label (optional)' }), 'Forum member');
    await user.click(screen.getByTestId('add-ref-submit'));

    expect(addMutate).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        input: { ref: 'acme.member:123456', role: 'reported_by', label: 'Forum member' },
      },
      expect.any(Object)
    );
  });

  it('links to the other task when the source is already taken, and keeps what was typed', async () => {
    const user = userEvent.setup();
    renderRefs([]);

    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    const input = screen.getByRole('textbox', { name: 'Link to add' });
    await user.type(input, 'forum.post:4411');
    await user.click(screen.getByRole('textbox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: 'Source' }));
    await user.click(screen.getByTestId('add-ref-submit'));

    const [, options] = addMutate.mock.calls[0];
    act(() => {
      options.onError(
        new refQueries.RefApiError(
          'forum.post:4411 is already the source of 3f2a91c0 "Old offer page"',
          409,
          '3f2a91c0-0000-4000-8000-000000000000'
        )
      );
    });

    expect(screen.getByTestId('add-ref-error')).toHaveTextContent(
      'Already the source of Old offer page'
    );
    expect(screen.getByRole('link', { name: 'Old offer page' })).toHaveAttribute(
      'href',
      '/tasks/3f2a91c0-0000-4000-8000-000000000000'
    );
    expect(input).toHaveValue('forum.post:4411');
    expect(screen.getByRole('textbox', { name: 'Role' })).toHaveValue('Source');
  });

  it('closes the form with Escape when the field is empty', async () => {
    const user = userEvent.setup();
    renderRefs([]);

    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('add-ref-form')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a link' })).toBeInTheDocument();
  });
});
