import { expect, test, type Page, type Route } from '@playwright/test';

const isLocalHost = (hostname: string) => ['localhost', '127.0.0.1', '::1'].includes(hostname);

type FixtureTask = {
  id: string;
  project: string;
  projectId: string;
  projectName: string;
  category: string;
  orgId: string;
  orgName: string;
  status: 'do' | 'done';
  priority: number;
  size: '**';
  userId: string;
  isMine: boolean;
  isShared: boolean;
  canEdit: true;
  isDeleted: false;
  customer?: string;
  epicId?: string | null;
  createdAt: string;
  updatedAt: string;
  statusLastChangedOn: string;
  notes: string;
};

type FixtureEpic = { id: string; title: string };

function makeTasks(
  count: number,
  status: 'do' | 'done' = 'do',
  distinctProjects = false
): FixtureTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `fictional-task-${index}`,
    project: `Fictional task ${index}`,
    projectId: distinctProjects ? `fictional-container-${index}` : 'fictional-container-one',
    projectName: distinctProjects ? `Fictional project ${index}` : 'Fictional project one',
    category: distinctProjects ? `Fictional project ${index}` : 'Fictional project one',
    orgId: 'fictional-workspace',
    orgName: 'Fictional Workspace',
    status,
    priority: 5,
    size: '**',
    userId: 'fictional-member',
    isMine: true,
    isShared: false,
    canEdit: true,
    isDeleted: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    statusLastChangedOn:
      status === 'done' ? '2026-10-01T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
    notes: `Fictional full body for task ${index}. This must arrive only after expansion.`,
  }));
}

async function installLocalApi(
  page: Page,
  tasks: FixtureTask[],
  outsideApiCalls: string[],
  epics: FixtureEpic[] = []
) {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({
      json: {
        user: {
          id: 'fictional-member',
          email: 'member@example.test',
          name: 'Member One',
        },
        accessToken: 'local-test-token',
        expires: '2026-10-12T00:00:00.000Z',
      },
    });
  });
  await page.route('**/api/v2/**', async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (!isLocalHost(requestUrl.hostname)) {
      outsideApiCalls.push(requestUrl.origin);
      await route.abort();
      return;
    }

    const { pathname, searchParams } = requestUrl;
    const method = route.request().method();
    if (pathname.endsWith('/users/me')) {
      await route.fulfill({
        json: { id: 'fictional-member', email: 'member@example.test', name: 'Member One' },
      });
      return;
    }
    if (pathname.endsWith('/organisations')) {
      await route.fulfill({
        json: [
          {
            id: 'fictional-workspace',
            name: 'Fictional Workspace',
            isPersonal: true,
            memberCount: 1,
          },
        ],
      });
      return;
    }
    if (/\/organisations\/[^/]+\/projects$/.test(pathname)) {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname.endsWith('/epics')) {
      await route.fulfill({ json: epics });
      return;
    }
    if (pathname.endsWith('/goals')) {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname.endsWith('/projects/counts')) {
      const counts = { do: 0, delay: 0, awaiting: 0, delegate: 0, done: 0 };
      tasks.forEach((task) => {
        counts[task.status] += 1;
      });
      await route.fulfill({ json: { byStatus: counts, total: tasks.length } });
      return;
    }
    if (pathname.endsWith('/projects')) {
      if (searchParams.get('doneBefore')) {
        const oldTasks = tasks.filter((task) => task.status === 'done');
        const summaries = oldTasks.map(({ notes: _notes, ...task }) => ({
          noteCount: 0,
          lastNoteAt: null,
          ...task,
        }));
        await route.fulfill({
          json: summaries,
          headers: { 'X-Total-Count': String(oldTasks.length) },
        });
        return;
      }
      const rows = tasks.filter((task) => {
        if (task.status !== 'done') {
          return true;
        }
        const cutoff = searchParams.get('doneSince');
        return !cutoff || task.statusLastChangedOn.slice(0, 10) >= cutoff;
      });
      const summaries = rows.map(({ notes: _notes, ...task }) => ({
        noteCount: 0,
        lastNoteAt: null,
        ...task,
      }));
      await route.fulfill({ json: summaries });
      return;
    }
    if (/\/projects\/[^/]+\/updates$/.test(pathname)) {
      await route.fulfill({ json: [] });
      return;
    }
    if (/\/projects\/[^/]+$/.test(pathname) && method === 'GET') {
      const task = tasks.find((candidate) => pathname.endsWith(`/${candidate.id}`));
      if (!task) {
        await route.fulfill({ status: 404, json: { error: 'Not found' } });
        return;
      }
      await route.fulfill({ json: task });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'Unmocked local API route' } });
  });
}

test.describe('board scale acceptance, local API only', () => {
  test('large collapsed sections make no body or timeline reads and hydrate one expanded card', async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !baseURL || !isLocalHost(new URL(baseURL).hostname),
      'Runs only against a local web app'
    );
    const tasks = makeTasks(80);
    const outsideApiCalls: string[] = [];
    let detailReads = 0;
    let timelineReads = 0;

    await page.addInitScript(() => localStorage.clear());
    await installLocalApi(page, tasks, outsideApiCalls);
    await page.route('**/api/v2/projects/*', async (route, request) => {
      const path = new URL(request.url()).pathname;
      if (/\/projects\/[^/]+\/updates$/.test(path)) {
        timelineReads += 1;
      } else if (
        !path.endsWith('/projects/counts') &&
        /\/projects\/[^/]+$/.test(path) &&
        request.method() === 'GET'
      ) {
        detailReads += 1;
      }
      await route.fallback();
    });

    await page.goto('/board');
    const section = page.getByTestId('section-do');
    await expect(section.getByRole('button', { name: 'Expand Do section' })).toBeVisible();
    expect(detailReads).toBe(0);
    expect(timelineReads).toBe(0);

    await section.getByRole('button', { name: 'Expand Do section' }).click();
    const controls = page.locator('[data-testid^="project-card-control-"]');
    await expect(controls).toHaveCount(50);
    expect(detailReads).toBe(0);
    expect(timelineReads).toBe(0);

    await page.getByTestId('project-card-control-fictional-task-0').click();
    await expect(
      page.getByText('Fictional full body for task 0. This must arrive only after expansion.')
    ).toBeVisible();
    await expect.poll(() => detailReads).toBe(1);
    await expect.poll(() => timelineReads).toBe(1);
    expect(outsideApiCalls).toEqual([]);
  });

  test('grouping many tasks does not multiply the initial card budget', async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !baseURL || !isLocalHost(new URL(baseURL).hostname),
      'Runs only against a local web app'
    );
    const tasks = makeTasks(80, 'do', true);
    const outsideApiCalls: string[] = [];

    await page.addInitScript(() => localStorage.clear());
    await installLocalApi(page, tasks, outsideApiCalls);
    await page.goto('/board?group=project');

    const section = page.getByTestId('section-do');
    await section.getByRole('button', { name: 'Expand Do section' }).click();
    await expect(page.locator('[data-testid^="project-card-control-"]')).toHaveCount(1);
    expect(outsideApiCalls).toEqual([]);
  });

  test('an empty recent Done section still offers the older archive', async ({ page, baseURL }) => {
    test.skip(
      !baseURL || !isLocalHost(new URL(baseURL).hostname),
      'Runs only against a local web app'
    );
    const tasks = makeTasks(18, 'done');
    tasks.forEach((task) => {
      task.statusLastChangedOn = '2026-08-01T00:00:00.000Z';
    });
    const outsideApiCalls: string[] = [];
    await page.addInitScript(() => localStorage.clear());
    await installLocalApi(page, tasks, outsideApiCalls);

    await page.goto('/board');
    const done = page.getByTestId('section-done');
    await done.getByRole('button', { name: 'Expand Done section' }).click();
    await done.getByRole('button', { name: /show older tasks/i }).click();
    await expect(done.getByText('Older tasks (18 loaded)')).toBeVisible();
    expect(outsideApiCalls).toEqual([]);
  });

  test('narrow task cards keep the title visible and wrap metadata below it', async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !baseURL || !isLocalHost(new URL(baseURL).hostname),
      'Runs only against a local web app'
    );
    const task: FixtureTask = {
      ...makeTasks(1)[0]!,
      project: 'Fictional task title should stay readable',
      category: 'Fictional project',
      isShared: true,
      customer: 'Fictional customer',
      epicId: 'fictional-epic',
    };
    const epic = { id: 'fictional-epic', title: 'Fictional epic' };
    const outsideApiCalls: string[] = [];
    await page.addInitScript(() => localStorage.clear());
    await installLocalApi(page, [task], outsideApiCalls, [epic]);

    for (const width of [375, 500]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/board');
      const section = page.getByTestId('section-do');
      await section.getByRole('button', { name: 'Expand Do section' }).click();
      const control = page.getByTestId(`project-card-control-${task.id}`);
      const title = control.getByText(task.project, { exact: true });
      const customer = control.getByRole('link', { name: task.customer! });

      await expect(title).toBeVisible();
      await expect(control.getByRole('button', { name: 'Assign to me' })).toBeVisible();
      await expect(customer).toBeVisible();
      await expect(control.getByRole('link', { name: task.category })).toBeVisible();
      await expect(control.getByRole('link', { name: epic.title })).toBeVisible();
      await expect(control.getByText('★★', { exact: true })).toBeVisible();

      const titleBox = await title.boundingBox();
      const customerBox = await customer.boundingBox();
      const controlWidth = await control.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));

      expect(titleBox?.width).toBeGreaterThanOrEqual(100);
      expect(customerBox?.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
      expect(controlWidth.scroll).toBeLessThanOrEqual(controlWidth.client);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      );
    }

    expect(outsideApiCalls).toEqual([]);
  });
});
