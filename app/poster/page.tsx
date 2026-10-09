'use client';

import React, { useMemo, useState } from 'react';
import {
  IconAlertCircle,
  IconDownload,
  IconMaximize,
  IconMinimize,
  IconPackage,
  IconPrinter,
} from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import ReactDOMServer from 'react-dom/server';
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import PrintableSvgPoster from '../../components/TimDoPage/PrintableSvgPoster';
import { generatePosterSvg } from '../../workers/src/services/posterSvgService';
import { useActiveTasksPoster } from '../hooks/useActiveTasksPoster';
import { useGoals } from '../hooks/useGoalQueries';
import { useProjects } from '../hooks/useProjectQueries';
import { useWallOfDonePoster } from '../hooks/useWallOfDonePoster';
import { PosterCanvas } from './PosterCanvas';
import classes from './PosterCanvas.module.css';

type PosterType = 'wall-of-done' | 'active-tasks' | 'goals-rhythm';

// With no tasks yet there is nothing to filter by
const FALLBACK_CATEGORIES: string[] = [];

export default function PosterStudioPage() {
  const { data: session } = useSession();
  const [posterType, setPosterType] = useState<PosterType>('wall-of-done');
  const [zoomMode, setZoomMode] = useState<'fit' | 'actual'>('fit');
  const [isExportingTiled, setIsExportingTiled] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [doneTimeframe, setDoneTimeframe] = useState<'6m' | '12m' | 'all'>('6m');

  const categoryFilterOptions = useMemo(() => {
    return selectedCategories.length > 0 ? selectedCategories : undefined;
  }, [selectedCategories]);

  // Queries for the 3 modes
  const wallOfDoneQuery = useWallOfDonePoster({
    format: 'svg',
    categories: categoryFilterOptions,
    timeframe: doneTimeframe,
  });
  const activeTasksQuery = useActiveTasksPoster({
    format: 'svg',
    categories: categoryFilterOptions,
  });
  const projectsQuery = useProjects();
  const goalsQuery = useGoals();

  // Posters are personal: they show my own tasks (assigned to me, or unassigned ones I created)
  // from every workspace, so the category chips come from those tasks too
  const myTasks = useMemo(
    () => (projectsQuery.data || []).filter((p) => p.isMine !== false),
    [projectsQuery.data]
  );
  const categoryChoices = useMemo(() => {
    const set = new Set<string>();
    myTasks.forEach((p) => {
      if (p.category) {
        set.add(p.category);
      }
    });
    return set.size > 0 ? Array.from(set).sort((a, b) => a.localeCompare(b)) : FALLBACK_CATEGORIES;
  }, [myTasks]);

  const handlePrint = () => {
    window.print();
  };

  // Helper to trigger safe download and URL cleanup
  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Active Tasks Poster fallback SVG string (if worker SVG query is not ready or fails)
  const activeTasksFallbackSvgString = useMemo(() => {
    if (!projectsQuery.data || !session?.user) {
      return null;
    }
    const filteredProjects = categoryFilterOptions
      ? myTasks.filter((p) => categoryFilterOptions.includes(p.category || ''))
      : myTasks;

    return ReactDOMServer.renderToString(
      <PrintableSvgPoster
        projects={filteredProjects}
        user={session.user.name || 'TimDo User'}
        mode="tasks"
      />
    );
  }, [projectsQuery.data, myTasks, session?.user, categoryFilterOptions]);

  // Goals & Rhythm Poster SVG string
  const goalsSvgString = useMemo(() => {
    if (!goalsQuery.data || goalsQuery.data.length === 0) {
      return generatePosterSvg({});
    }
    const aims = goalsQuery.data.filter((g) => g.type === 'aim');
    const focuses = goalsQuery.data.filter((g) => g.type === 'focus');
    const values = goalsQuery.data.filter((g) => g.type === 'value');
    const housekeeping = goalsQuery.data.filter((g) => g.type === 'housekeeping');

    return generatePosterSvg({
      aims: aims as any,
      focuses: focuses as any,
      values: values as any,
      housekeeping: housekeeping as any,
    });
  }, [goalsQuery.data]);

  // Active tasks SVG: prefer server-generated active tasks poster SVG, fallback to client render
  const activeTasksSvgMarkup = useMemo(() => {
    if (typeof activeTasksQuery.data === 'string' && activeTasksQuery.data.trim()) {
      return activeTasksQuery.data;
    }
    return activeTasksFallbackSvgString || undefined;
  }, [activeTasksQuery.data, activeTasksFallbackSvgString]);

  // Master SVG download handler
  const handleDownloadMasterSvg = () => {
    const date = new Date().toISOString().split('T')[0];
    const categorySuffix = selectedCategories.length > 0 ? `-${selectedCategories.join('-')}` : '';

    if (posterType === 'wall-of-done') {
      if (typeof wallOfDoneQuery.data === 'string') {
        const blob = new Blob([wallOfDoneQuery.data], { type: 'image/svg+xml' });
        triggerDownload(blob, `timdo-wall-of-done${categorySuffix}-${date}.svg`);
      }
    } else if (posterType === 'active-tasks') {
      if (activeTasksSvgMarkup) {
        const blob = new Blob([activeTasksSvgMarkup], { type: 'image/svg+xml' });
        triggerDownload(blob, `timdo-active-tasks${categorySuffix}-${date}.svg`);
      }
    } else if (posterType === 'goals-rhythm') {
      if (goalsSvgString) {
        const blob = new Blob([goalsSvgString], { type: 'image/svg+xml' });
        triggerDownload(blob, `timdo-life-goals-${date}.svg`);
      }
    }
  };

  // 6x A4 Tiled Package download handler (fetches tiled format)
  const handleDownloadTiledPackage = async () => {
    setIsExportingTiled(true);
    try {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      const date = new Date().toISOString().split('T')[0];
      const categorySuffix =
        selectedCategories.length > 0 ? `-${selectedCategories.join('-')}` : '';

      if (posterType === 'wall-of-done') {
        const { getWallOfDonePoster } = await import('../lib/apiClient');
        const tiledData = (await getWallOfDonePoster(
          { tiled: true, categories: categoryFilterOptions, timeframe: doneTimeframe },
          session.accessToken
        )) as any;

        if (tiledData && tiledData.tiles && Array.isArray(tiledData.tiles)) {
          tiledData.tiles.forEach((tile: any, index: number) => {
            setTimeout(() => {
              const blob = new Blob([tile.svg], { type: 'image/svg+xml' });
              triggerDownload(
                blob,
                `timdo-wall-of-done-sheet-${index + 1}${categorySuffix}-${date}.svg`
              );
            }, index * 200);
          });
        }
      } else if (posterType === 'active-tasks') {
        const { getActiveTasksPoster } = await import('../lib/apiClient');
        const tiledData = (await getActiveTasksPoster(
          { tiled: true, categories: categoryFilterOptions },
          session.accessToken
        )) as any;

        if (tiledData && tiledData.tiles && Array.isArray(tiledData.tiles)) {
          tiledData.tiles.forEach((tile: any, index: number) => {
            setTimeout(() => {
              const blob = new Blob([tile.svg], { type: 'image/svg+xml' });
              triggerDownload(
                blob,
                `timdo-active-tasks-4xa4-sheet-${index + 1}${categorySuffix}-${date}.svg`
              );
            }, index * 200);
          });
        }
      } else if (posterType === 'goals-rhythm') {
        const { getLifeGoalsPoster } = await import('../lib/apiClient');
        const tiledData = (await getLifeGoalsPoster({ tiled: true }, session.accessToken)) as any;

        if (tiledData && tiledData.tiles && Array.isArray(tiledData.tiles)) {
          tiledData.tiles.forEach((tile: any, index: number) => {
            setTimeout(() => {
              const blob = new Blob([tile.svg], { type: 'image/svg+xml' });
              triggerDownload(blob, `timdo-life-goals-4xa4-sheet-${index + 1}-${date}.svg`);
            }, index * 200);
          });
        }
      }
    } catch {
      // Ignore or handle download error
    } finally {
      setIsExportingTiled(false);
    }
  };

  // Loading & error states
  const isLoading =
    posterType === 'wall-of-done'
      ? wallOfDoneQuery.isLoading
      : posterType === 'active-tasks'
        ? activeTasksQuery.isLoading && projectsQuery.isLoading
        : goalsQuery.isLoading;

  const isError =
    posterType === 'wall-of-done'
      ? wallOfDoneQuery.isError
      : posterType === 'active-tasks'
        ? activeTasksQuery.isError && projectsQuery.isError
        : goalsQuery.isError;

  const currentSvgMarkup =
    posterType === 'wall-of-done'
      ? typeof wallOfDoneQuery.data === 'string'
        ? wallOfDoneQuery.data
        : undefined
      : posterType === 'active-tasks'
        ? activeTasksSvgMarkup
        : goalsSvgString || undefined;

  return (
    <Container size="xl" py="md">
      <Stack gap="md">
        {/* Controls Toolbar (hidden on print) */}
        <Box className={classes.noPrint}>
          <Paper p="md" withBorder radius="md">
            <Stack gap="sm">
              <Group justify="space-between" align="center" wrap="wrap">
                <div>
                  <Title order={2}>Poster Studio</Title>
                  <Text size="xs" c="dimmed">
                    Personal: your own tasks across all your workspaces.
                  </Text>
                </div>
                <SegmentedControl
                  value={posterType}
                  onChange={(val) => setPosterType(val as PosterType)}
                  data={[
                    { value: 'wall-of-done', label: 'Wall of Done (6× A4)' },
                    { value: 'active-tasks', label: 'Active Tasks Readout' },
                    { value: 'goals-rhythm', label: 'Life Goals & Routines' },
                  ]}
                />
              </Group>

              {/* Timeframe Filter Bar for Wall of Done */}
              {posterType === 'wall-of-done' && (
                <Group gap="xs" align="center" wrap="wrap">
                  <Text size="sm" c="dimmed" fw={500}>
                    Completed Timeframe:
                  </Text>
                  <SegmentedControl
                    size="xs"
                    value={doneTimeframe}
                    onChange={(val) => setDoneTimeframe(val as '6m' | '12m' | 'all')}
                    data={[
                      { value: '6m', label: 'Last 6 Months (Default)' },
                      { value: '12m', label: 'Last 12 Months' },
                      { value: 'all', label: 'All Time' },
                    ]}
                  />
                </Group>
              )}

              {/* Category Multi-Select Filter Bar (Wall of Done and Active Tasks) */}
              {posterType !== 'goals-rhythm' && (
                <Group gap="xs" align="center" wrap="wrap">
                  <Text size="sm" c="dimmed" fw={500}>
                    Categories:
                  </Text>
                  <Chip
                    checked={selectedCategories.length === 0}
                    onChange={() => setSelectedCategories([])}
                    size="xs"
                    variant="outline"
                  >
                    All Categories
                  </Chip>
                  <Chip.Group multiple value={selectedCategories} onChange={setSelectedCategories}>
                    <Group gap="xs" wrap="wrap">
                      {categoryChoices.map((cat) => (
                        <Chip key={cat} value={cat} size="xs" variant="outline">
                          {cat}
                        </Chip>
                      ))}
                    </Group>
                  </Chip.Group>
                </Group>
              )}

              <Group justify="space-between" align="center" wrap="wrap">
                {/* Zoom Mode Toggle */}
                <Group gap="xs">
                  <Text size="sm" c="dimmed" fw={500}>
                    Scale:
                  </Text>
                  <Tooltip
                    label={zoomMode === 'fit' ? 'Switch to 100% Actual Scale' : 'Fit to Window'}
                  >
                    <Button
                      variant="default"
                      size="xs"
                      leftSection={
                        zoomMode === 'fit' ? (
                          <IconMaximize size="0.9rem" />
                        ) : (
                          <IconMinimize size="0.9rem" />
                        )
                      }
                      onClick={() => setZoomMode(zoomMode === 'fit' ? 'actual' : 'fit')}
                    >
                      {zoomMode === 'fit' ? 'Fit to Screen' : '100% Actual Scale'}
                    </Button>
                  </Tooltip>
                </Group>

                {/* Actions Toolbar */}
                <Group gap="xs">
                  <Button
                    variant="default"
                    size="xs"
                    leftSection={<IconDownload size="0.9rem" />}
                    onClick={handleDownloadMasterSvg}
                    disabled={isLoading || isError || !currentSvgMarkup}
                  >
                    Download Master SVG
                  </Button>

                  <Button
                    variant="default"
                    size="xs"
                    leftSection={<IconPackage size="0.9rem" />}
                    onClick={handleDownloadTiledPackage}
                    loading={isExportingTiled}
                    disabled={isLoading || isError}
                  >
                    {posterType === 'wall-of-done'
                      ? 'Download 6× A4 Tiled Package'
                      : 'Download 4× A4 Tiled Package'}
                  </Button>

                  <Button
                    variant="filled"
                    color="dark"
                    size="xs"
                    leftSection={<IconPrinter size="0.9rem" />}
                    onClick={handlePrint}
                    disabled={isLoading || isError || !currentSvgMarkup}
                  >
                    Print (Laser Optimized)
                  </Button>
                </Group>
              </Group>
            </Stack>
          </Paper>
        </Box>

        {/* Canvas Display Viewport */}
        {isLoading ? (
          <Box className={classes.viewport} style={{ alignItems: 'center' }}>
            <Stack align="center" gap="sm">
              <Loader size="lg" />
              <Text size="sm" c="dimmed">
                Rendering vector poster layout...
              </Text>
            </Stack>
          </Box>
        ) : isError ? (
          <Alert
            icon={<IconAlertCircle size="1rem" />}
            title="Poster Generation Failed"
            color="red"
          >
            Could not generate poster preview. Please verify that your account has data and try
            again.
          </Alert>
        ) : (
          <PosterCanvas zoomMode={zoomMode} svgMarkup={currentSvgMarkup} />
        )}
      </Stack>
    </Container>
  );
}
