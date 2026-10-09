'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  IconFileImport,
  IconFlag,
  IconFolder,
  IconHistory,
  IconLayoutKanban,
  IconLogout,
  IconPlus,
  IconPrinter,
  IconTarget,
  IconTerminal2,
  IconUsers,
} from '@tabler/icons-react';
import { signOut, useSession } from 'next-auth/react';
import { AppShell, Burger, Button, Group, Kbd, NavLink, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useInstanceConfig } from '../../app/hooks/useInstanceConfig';
import { useCreateProject } from '../../app/hooks/useProjectMutations';
import type { ProjectCreateInput } from '../../app/types/project.types';
import { CreateProjectModal } from '../CreateProjectModal/CreateProjectModal';
import { ImportProjects } from '../ImportProjects/ImportProjects';
import { VoiceCommand } from '../VoiceCommand/VoiceCommand';
import { VoiceCommandIntro } from '../VoiceCommand/VoiceCommandIntro';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [opened, { toggle }] = useDisclosure();
  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure();
  const [importModalOpened, { open: openImportModal, close: closeImportModal }] = useDisclosure();
  const { status } = useSession();
  const createProjectMutation = useCreateProject();
  const router = useRouter();
  const pathname = usePathname();
  const { features } = useInstanceConfig();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is actively typing in an input, textarea, or contentEditable
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCreateModal();
        return;
      }

      if (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        openCreateModal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openCreateModal]);

  const handleCreateProject = (newProjectData: ProjectCreateInput) => {
    createProjectMutation.mutate(newProjectData);
    closeCreateModal();
  };

  const handleImportProjects = async (projects: ProjectCreateInput[]) => {
    // Import projects one by one using the create mutation
    for (const project of projects) {
      await new Promise<void>((resolve, reject) => {
        createProjectMutation.mutate(project, {
          onSuccess: () => resolve(),
          onError: (error) => reject(error),
        });
      });
    }
  };

  const handleLogoClick = () => {
    router.push('/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Skip AppShell for onboarding - render full-screen
  if (pathname === '/onboarding') {
    return <>{children}</>;
  }

  if (status === 'authenticated') {
    return (
      <>
        <AppShell
          header={{ height: 60 }}
          navbar={{
            width: 300,
            breakpoint: 'sm',
            collapsed: { mobile: !opened },
          }}
          padding="md"
        >
          <AppShell.Header>
            <Group h="100%" px="md" justify="space-between">
              <Group>
                <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
                <Text fw={700} onClick={handleLogoClick} style={{ cursor: 'pointer' }}>
                  TimDo
                </Text>
              </Group>
              <Group gap="xs">
                <Button
                  variant="light"
                  size="xs"
                  color="violet"
                  leftSection={<IconPlus size={14} />}
                  rightSection={
                    <Group gap={4} visibleFrom="sm">
                      <Kbd size="xs">⌘</Kbd>
                      <Kbd size="xs">K</Kbd>
                    </Group>
                  }
                  onClick={openCreateModal}
                >
                  Quick Add
                </Button>
                {/* Desktop voice command button - visible on desktop */}
                <Group visibleFrom="sm">
                  <VoiceCommand compact />
                </Group>
                {/* Mobile voice command button - visible only on mobile */}
                <Group hiddenFrom="sm">
                  <VoiceCommand compact />
                </Group>
              </Group>
            </Group>
          </AppShell.Header>

          <AppShell.Navbar p="md">
            <VoiceCommand />
            <NavLink
              component={Link}
              href="/board"
              label="Board"
              active={pathname === '/board'}
              leftSection={<IconLayoutKanban size="1rem" stroke={1.5} />}
            />
            <NavLink
              component={Link}
              href="/projects"
              label="Projects"
              active={pathname?.startsWith('/projects')}
              leftSection={<IconFolder size="1rem" stroke={1.5} />}
            />
            <NavLink
              component={Link}
              href="/epics"
              label="Epics"
              active={pathname?.startsWith('/epics')}
              leftSection={<IconFlag size="1rem" stroke={1.5} />}
            />
            <NavLink
              component={Link}
              href="/activity"
              label="Activity"
              active={pathname?.startsWith('/activity')}
              leftSection={<IconHistory size="1rem" stroke={1.5} />}
            />
            <NavLink
              component={Link}
              href="/sharing"
              label="Sharing"
              active={pathname?.startsWith('/sharing')}
              leftSection={<IconUsers size="1rem" stroke={1.5} />}
            />
            {features.goals && (
              <NavLink
                component={Link}
                href="/goals"
                label="Life Goals"
                active={pathname === '/goals'}
                leftSection={<IconTarget size="1rem" stroke={1.5} />}
              />
            )}
            <NavLink
              label="Create New Task"
              leftSection={<IconPlus size="1rem" stroke={1.5} />}
              onClick={openCreateModal}
            />
            <NavLink
              label="Import Projects"
              leftSection={<IconFileImport size="1rem" stroke={1.5} />}
              onClick={openImportModal}
            />
            {features.poster && (
              <NavLink
                component={Link}
                href="/poster"
                label="Poster Studio"
                active={pathname === '/poster'}
                leftSection={<IconPrinter size="1rem" stroke={1.5} />}
              />
            )}
            <NavLink
              component={Link}
              href="/settings/access"
              label="CLI & MCP"
              active={pathname?.startsWith('/settings/access')}
              leftSection={<IconTerminal2 size="1rem" stroke={1.5} />}
            />
            <NavLink
              label="Logout"
              leftSection={<IconLogout size="1rem" stroke={1.5} />}
              onClick={() => signOut({ callbackUrl: '/' })}
            />
          </AppShell.Navbar>

          <AppShell.Main>{children}</AppShell.Main>
        </AppShell>
        <CreateProjectModal
          opened={createModalOpened}
          onClose={closeCreateModal}
          onSave={handleCreateProject}
        />
        <ImportProjects
          opened={importModalOpened}
          onClose={closeImportModal}
          onImport={handleImportProjects}
        />
        <VoiceCommandIntro />
      </>
    );
  }

  return <>{children}</>;
}
