export const CASEY_ID = 'scale-user-casey';
export const JORDAN_ID = 'scale-user-jordan';

const taskId = (index: number) => `scale-task-${String(index).padStart(4, '0')}`;
const projectId = (index: number) => `scale-project-${String(index).padStart(3, '0')}`;

/** Seed a stable 1,000-task multi-workspace fixture for list and count acceptance tests. */
export function seedBoardScale(raw: any) {
  raw.exec(`
    INSERT INTO Users (id, email, name) VALUES
      ('${CASEY_ID}', 'casey@example.test', 'Casey Example'),
      ('${JORDAN_ID}', 'jordan@example.test', 'Jordan Example');
    INSERT INTO Organisations (id, name, slug, created_by, is_personal) VALUES
      ('org-casey', 'Casey Example', 'casey-example', '${CASEY_ID}', 1),
      ('org-md', 'Northstar Workshop', 'northstar-workshop', '${CASEY_ID}', 0),
      ('org-viewer', 'Northstar Workshop', 'northstar-viewer', '${CASEY_ID}', 0);
    INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES
      ('personal-owner', 'org-casey', '${CASEY_ID}', 'owner'),
      ('shared-owner', 'org-md', '${CASEY_ID}', 'owner'),
      ('shared-member', 'org-md', '${JORDAN_ID}', 'member'),
      ('viewer-owner', 'org-viewer', '${CASEY_ID}', 'owner'),
      ('viewer-member', 'org-viewer', '${JORDAN_ID}', 'viewer');
    INSERT INTO Projects (id, org_id, key, name) VALUES
      ('proj-personal', 'org-casey', 'PER', 'Personal'),
      ('proj-acme-solar', 'org-md', 'ACS', 'Acme Solar'),
      ('proj-md', 'org-md', 'NSW', 'Northstar Workshop'),
      ('project-viewer', 'org-viewer', 'VIEW', 'Viewer fixture');
    INSERT INTO Goals (id, user_id, type, title) VALUES
      ('scale-goal-casey', '${CASEY_ID}', 'aim', 'Private fixture goal'),
      ('scale-goal-jordan', '${JORDAN_ID}', 'focus', 'Private fixture goal');
  `);

  const insertProject = raw.prepare(
    'INSERT INTO Projects (id, org_id, key, name) VALUES (?, ?, ?, ?)'
  );
  for (let index = 0; index < 110; index++) {
    insertProject.run(projectId(index), 'org-md', `S${String(index).padStart(2, '0')}`, `Scale ${index}`);
  }
  raw.prepare(
    'INSERT INTO Epics (id, user_id, title, status, project_id, updated_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('scale-epic', CASEY_ID, 'Scale fixture epic', 'active', projectId(0), CASEY_ID);

  const insertTask = raw.prepare(`
    INSERT INTO Tasks (
      id, project_id, epic_id, reporter_id, assignee_id, title, reason, status, priority, size,
      notes, status_last_changed_on, await_until, gmail_thread_id, customer, tags, is_deleted,
      updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const statuses = [
    ...Array(213).fill('do'),
    ...Array(213).fill('delay'),
    ...Array(212).fill('awaiting'),
    ...Array(212).fill('delegate'),
    ...Array(150).fill('done'),
  ];
  for (let index = 0; index < 1000; index++) {
    const status = statuses[index];
    const isRecentDone = index >= 850 && index < 890;
    const isOldDone = index >= 890;
    const project = index === 998 ? 'project-viewer' : index === 999 ? 'proj-personal' : projectId(index % 110);
    const createdAt = isOldDone
      ? index % 4 === 0
        ? '2026-01-15 09:00:00'
        : '2026-01-15T09:00:00.000Z'
      : index % 5 === 0
        ? '2026-09-01 09:00:00'
        : '2026-09-01T09:00:00.000Z';
    const completedAt = index === 889
      ? '2026-09-26T00:00:00.000Z'
      : isRecentDone
        ? index % 2 === 0
          ? '2026-10-09T12:00:00.000Z'
          : '2026-10-09 12:00:00'
        : isOldDone && index % 4 !== 0
          ? '2026-09-25T12:00:00.000Z'
          : status === 'done'
            ? null
            : index % 7 === 0
              ? null
              : '2026-10-01T12:00:00.000Z';
    const updatedAt = index === 0 || index === 426 || index === 890
      ? '2026-10-10T12:00:00.000Z'
      : index % 17 === 0
        ? null
        : index % 3 === 0
          ? '2026-10-09 12:00:00'
          : '2026-10-09T12:00:00.000Z';
    const epic = index % 2 === 0 ? 'scale-epic' : null;
    const reporter = index % 2 === 0 ? CASEY_ID : JORDAN_ID;
    const assignee = index % 3 === 0 ? CASEY_ID : index % 3 === 1 ? JORDAN_ID : null;
    insertTask.run(
      taskId(index),
      project,
      epic,
      reporter,
      assignee,
      `Scale task ${String(index).padStart(4, '0')}`,
      'A deterministic fixture task',
      status,
      index === 0 || index === 426 ? 10 : index % 10 + 1,
      '***',
      index === 20
        ? `Full task body ${index}\n\n${'A longer fictional task body must stay intact when its summary is edited.\n'.repeat(400)}`
        : `Full task body ${index}`,
      completedAt,
      status === 'awaiting' ? '2026-12-01' : null,
      null,
      'Acme Solar',
      index % 2 === 0 ? 'scale,fixture' : 'fixture',
      reporter,
      createdAt,
      updatedAt
    );
  }

  const insertNote = raw.prepare(
    'INSERT INTO TaskUpdates (id, task_id, author_id, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertNote.run('scale-note-1', taskId(0), CASEY_ID, 'First fixture update', '2026-10-08T09:00:00.000Z', '2026-10-08T09:00:00.000Z');
  insertNote.run('scale-note-2', taskId(0), JORDAN_ID, 'Second fixture update', '2026-10-09 09:00:00', '2026-10-09 09:00:00');
  insertNote.run('scale-note-3', taskId(1), JORDAN_ID, 'Jordan fixture update', '2026-10-07T09:00:00.000Z', '2026-10-07T09:00:00.000Z');
  insertNote.run('scale-note-4', taskId(426), CASEY_ID, 'First selected update', '2026-10-08T09:00:00.000Z', '2026-10-08T09:00:00.000Z');
  insertNote.run('scale-note-5', taskId(426), JORDAN_ID, 'Latest selected update', '2026-10-09 09:00:00', '2026-10-09 09:00:00');

  const insertGoal = raw.prepare(
    'INSERT INTO TaskUserGoals (task_id, user_id, goal_id) VALUES (?, ?, ?)'
  );
  insertGoal.run(taskId(1), CASEY_ID, 'scale-goal-casey');
  insertGoal.run(taskId(1), JORDAN_ID, 'scale-goal-jordan');
  insertGoal.run(taskId(2), CASEY_ID, 'scale-goal-casey');

  raw.prepare(
    'INSERT INTO TaskRelations (id, source_task_id, target_task_id, relation_type, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run('scale-relation', taskId(2), taskId(3), 'relates_to', CASEY_ID);
  raw.prepare(
    'INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('scale-ref', taskId(1), 'org-md', 'link', 'forum.post', 'scale-fixture-1', 'Fixture link', CASEY_ID, '2026-10-08T09:00:00.000Z');
  raw.prepare(
    'INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('scale-ref-2', taskId(2), 'org-md', 'source', 'forum.post', 'scale-fixture-2', 'Fixture source', JORDAN_ID, '2026-10-08T09:00:00.000Z');
}

export const boardScaleTaskId = taskId;
export const boardScaleProjectId = projectId;
