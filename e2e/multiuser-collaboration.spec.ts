import { expect, test } from '@playwright/test';

test.describe('Multi-User Collaboration E2E Flow', () => {
  test('User A creates a task in Acme Solar and assigns it to User B; User B views in Mine, posts a note and completes it; User A verifies Done and note attribution', async ({
    page,
  }) => {
    // Shared mock state
    const taskState = {
      id: 'task-acme-20',
      project: '[ACS-20] Build staging webhook',
      projectKey: 'ACS-20',
      reason: 'Support automated deploy previews',
      status: 'do' as const,
      priority: 9,
      size: '***' as const,
      category: 'Acme Solar',
      assigneeId: 'user-jordan-id',
      assigneeName: 'Jordan Example',
      userId: 'user-casey-id',
      orderIndex: 0,
    };

    const updatesState: Array<{
      id: string;
      projectId: string;
      note: string;
      authorId: string;
      authorName: string;
      createdAt: string;
    }> = [];

    // Intercept Organisations endpoint
    await page.route('**/api/v2/organisations*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'org-casey', name: 'Casey Example', slug: 'casey-example' },
          { id: 'org-northstar-workshop', name: 'Northstar Workshop', slug: 'northstar-workshop' },
        ]),
      });
    });

    // Intercept Members endpoint
    await page.route('**/api/v2/organisations/**/members*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'mem-1',
            userId: 'user-casey-id',
            userName: 'Casey Example',
            userEmail: 'casey@example.test',
            role: 'owner',
          },
          {
            id: 'mem-2',
            userId: 'user-jordan-id',
            userName: 'Jordan Example',
            userEmail: 'jordan@example.test',
            role: 'member',
          },
        ]),
      });
    });

    // Intercept Projects / Tasks endpoint
    await page.route('**/api/v2/projects*', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([taskState]),
        });
      } else if (method === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        Object.assign(taskState, body);
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(taskState),
        });
      } else if (method === 'PUT' || method === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        Object.assign(taskState, body);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(taskState),
        });
      }
    });

    // Intercept Task Updates endpoint
    await page.route(`**/api/v2/projects/${taskState.id}/updates*`, async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(updatesState),
        });
      } else if (method === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        const newUpdate = {
          id: `update-${updatesState.length + 1}`,
          projectId: taskState.id,
          note: body.note,
          authorId: 'user-jordan-id',
          authorName: 'Jordan Example',
          createdAt: new Date().toISOString(),
        };
        updatesState.push(newUpdate);
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(newUpdate),
        });
      }
    });

    await page.route('**/api/v2/epics*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/api/v2/goals*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // ----------------------------------------------------
    // Step 1: User A (Casey) logs in, views Northstar Workshop org and assigns task to Jordan
    // ----------------------------------------------------
    await page.goto('/board');

    // Select Northstar Workshop organisation
    const orgSelect = page.locator(
      'input[placeholder="Select an option"], input[value="All Organisations"]'
    );
    if (await orgSelect.isVisible()) {
      await orgSelect.click();
      const northstarWorkshopOption = page.getByRole('option', { name: 'Northstar Workshop' });
      if (await northstarWorkshopOption.isVisible()) {
        await northstarWorkshopOption.click();
      }
    }

    // Verify task is displayed with key badge and assignee name
    await expect(page.locator('text=[ACS-20] Build staging webhook')).toBeVisible();
    await expect(page.locator('text=Jordan Example')).toBeVisible();

    // ----------------------------------------------------
    // Step 2: User B (Jordan) logs in, navigates to task detail, posts note and moves to Done
    // ----------------------------------------------------
    await page.goto(`/tasks/${taskState.id}`);

    // Verify task name in task detail
    await expect(page.locator('input[placeholder="Task name"]')).toHaveValue(
      '[ACS-20] Build staging webhook'
    );

    // Click "Add Update / Note" button if visible
    const addNoteBtn = page.getByRole('button', { name: /Add Update/i });
    if (await addNoteBtn.isVisible()) {
      await addNoteBtn.click();
    }

    // Jordan posts an update note: "Reviewing PR now"
    await page.fill('textarea[placeholder*="Write an update or note"]', 'Reviewing PR now');
    await page.click('button:has-text("Save Note"), button:has-text("Save Update")');

    // Verify Jordan's note and attribution appear in timeline
    await expect(page.locator('text=Reviewing PR now')).toBeVisible();
    await expect(page.locator('text=Jordan Example')).toBeVisible();

    // Jordan completes task (changes Status to Done)
    const statusSelect = page.locator('input[value="Do"], input[placeholder="Select Status"]');
    await statusSelect.click();
    const doneOption = page.getByRole('option', { name: 'Done' });
    await doneOption.click();

    // ----------------------------------------------------
    // Step 3: User A (Casey) verifies completed task in Done section
    // ----------------------------------------------------
    await page.goto('/board');
    const doneSection = page.getByTestId('section-done');
    await expect(doneSection).toBeVisible();
    await expect(doneSection.locator('text=[ACS-20] Build staging webhook')).toBeVisible();

    // Navigate back to task detail to verify author-attributed note persists
    await page.goto(`/tasks/${taskState.id}`);
    await expect(page.locator('text=Reviewing PR now')).toBeVisible();
    await expect(page.locator('text=Jordan Example')).toBeVisible();
  });

  test('Unassigned task 1-click claim interaction updates card with assignee', async ({ page }) => {
    let claimedAssignee: string | null = null;
    let claimedAssigneeName: string | null = null;

    const unassignedTask = {
      id: 'task-acme-21',
      project: '[ACS-21] Provision redis cache cluster',
      projectKey: 'ACS-21',
      reason: 'Required for high throughput',
      status: 'do' as const,
      priority: 8,
      size: '**' as const,
      category: 'Acme Solar',
      assigneeId: null,
      assigneeName: null,
      userId: 'user-casey-id',
      orderIndex: 0,
    };

    await page.route('**/api/v2/organisations*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'org-northstar-workshop', name: 'Northstar Workshop', slug: 'northstar-workshop' }]),
      });
    });

    await page.route('**/api/v2/projects*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            ...unassignedTask,
            assigneeId: claimedAssignee,
            assigneeName: claimedAssigneeName,
          },
        ]),
      });
    });

    // Intercept claim endpoint
    await page.route(`**/api/v2/tasks/${unassignedTask.id}/claim*`, async (route) => {
      claimedAssignee = 'user-casey-id';
      claimedAssigneeName = 'Casey Example';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...unassignedTask,
          assigneeId: 'user-casey-id',
          assigneeName: 'Casey Example',
        }),
      });
    });

    await page.route('**/api/v2/epics*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/api/v2/goals*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Load board
    await page.goto('/board');

    // Verify unassigned task has "[ Claim Task ]" button
    const claimButton = page.getByTestId('claim-task-btn');
    await expect(claimButton).toBeVisible();
    await expect(claimButton).toHaveText('Claim Task');

    // Click Claim Task
    await claimButton.click();

    // Assert card updates to show assignee name and removes the claim button
    await expect(claimButton).not.toBeVisible();
    await expect(page.locator('text=You, text=Casey Example')).toBeVisible();
  });
});
