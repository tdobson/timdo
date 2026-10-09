'use client';

import React from 'react';
import { useSession } from 'next-auth/react';
import { Alert, Container, Loader } from '@mantine/core';
import { useEpics } from '../../app/hooks/useEpicQueries';
import { useGoals } from '../../app/hooks/useGoalQueries';
import { useInstanceConfig } from '../../app/hooks/useInstanceConfig';
import { useProjects } from '../../app/hooks/useProjectQueries';
import { FeatureSwitchedOff } from '../../components/FeatureSwitchedOff';
import { GoalsDashboardView } from '../../components/GoalsDashboard/GoalsDashboardView';

export default function GoalsDashboardPage() {
  const { data: session, status } = useSession();

  const { data: goals, isLoading: isGoalsLoading, isError: isGoalsError } = useGoals();

  // Life goals are personal; task and epic links come from every workspace I'm in, and the
  // API only returns my own goal links
  const { data: projects, isLoading: isProjectsLoading, isError: isProjectsError } = useProjects();
  const { data: epics, isLoading: isEpicsLoading, isError: isEpicsError } = useEpics();
  const { features } = useInstanceConfig();

  if (!features.goals) {
    return <FeatureSwitchedOff what="Life goals" />;
  }

  if (status === 'loading' || isGoalsLoading || isProjectsLoading || isEpicsLoading) {
    return (
      <Container size="lg" py="xl">
        <Loader role="status" aria-label="Loading goals" />
      </Container>
    );
  }

  if (isGoalsError || isProjectsError || isEpicsError) {
    return (
      <Container size="lg" py="xl">
        <Alert title="Error" color="red">
          Could not load Life Goals data.
        </Alert>
      </Container>
    );
  }

  return (
    <GoalsDashboardView
      goals={goals || []}
      projects={projects || []}
      epics={epics || []}
      accessToken={session?.accessToken}
    />
  );
}
