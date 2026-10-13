'use client';

import React, { useMemo, useState } from 'react';
import { IconBuilding, IconFolder } from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import { Box, Card, Container, Group, Select, Stack, Text, Title } from '@mantine/core';
import { ActivityFeed } from '../../components/Activity/ActivityFeed';
import { workspaceLabel } from '../../components/Sharing/sharingRules';
import { SignInPrompt } from '../../components/Sharing/SignInPrompt';
import { useSharingOverview } from '../hooks/useSharingQueries';

const PAGE_SIZE = 50;

export default function ActivityPage() {
  const { status } = useSession();
  const { data: workspaces = [], isLoading: workspacesLoading } = useSharingOverview();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const filters = {
    orgId: orgId || undefined,
    projectId: projectId || undefined,
  };

  const workspaceOptions = workspaces.map((w) => ({ value: w.id, label: workspaceLabel(w) }));
  const projectOptions = useMemo(() => {
    const source = orgId ? workspaces.filter((w) => w.id === orgId) : workspaces;
    if (orgId || source.length <= 1) {
      return source.flatMap((w) => w.projects.map((p) => ({ value: p.id, label: p.name })));
    }
    return source
      .filter((w) => w.projects.length > 0)
      .map((w) => ({
        group: workspaceLabel(w),
        items: w.projects.map((p) => ({ value: p.id, label: p.name })),
      }));
  }, [workspaces, orgId]);

  if (status === 'unauthenticated') {
    return (
      <Container size="md" py="xl">
        <SignInPrompt title="Activity" message="Sign in to see who did what." />
      </Container>
    );
  }

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <Box>
          <Title order={1}>Activity</Title>
          <Text c="dimmed" size="sm">
            Who did what, across every workspace you&apos;re in.
          </Text>
        </Box>

        <Group gap="sm" align="flex-end" wrap="wrap">
          <Select
            label="Workspace"
            placeholder="All workspaces"
            data={workspaceOptions}
            value={orgId}
            onChange={(value) => {
              setOrgId(value);
              setProjectId(null);
            }}
            clearable
            disabled={workspacesLoading}
            leftSection={<IconBuilding size={16} />}
            style={{ flex: '1 1 200px' }}
            maw={320}
            data-testid="activity-workspace-filter"
          />
          <Select
            label="Project"
            placeholder="All projects"
            data={projectOptions}
            value={projectId}
            onChange={setProjectId}
            clearable
            searchable
            nothingFoundMessage="No matching projects"
            disabled={workspacesLoading}
            leftSection={<IconFolder size={16} />}
            style={{ flex: '1 1 200px' }}
            maw={320}
            data-testid="activity-project-filter"
          />
        </Group>

        <Card withBorder radius="md" padding="lg">
          <ActivityFeed
            orgId={filters.orgId}
            projectId={filters.projectId}
            limit={PAGE_SIZE}
            paged
          />
        </Card>
      </Stack>
    </Container>
  );
}
