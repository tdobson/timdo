'use client';

import React, { useState } from 'react';
import { IconBrandGithub, IconRefresh } from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { CreateTokenForm } from '../../../components/Access/CreateTokenForm';
import { NewTokenPanel } from '../../../components/Access/NewTokenPanel';
import { SetupSteps } from '../../../components/Access/SetupSteps';
import { TokenList } from '../../../components/Access/TokenList';
import { SignInPrompt } from '../../../components/Sharing/SignInPrompt';
import { useApiTokens, type CreatedApiToken } from '../../hooks/useApiTokens';
import { INSTANCE } from '../../lib/instance';

const REPO_URL = INSTANCE.repoUrl;

function TokenSkeleton() {
  return (
    <Stack gap="sm" role="status" aria-label="Loading tokens">
      {[0, 1].map((i) => (
        <Group key={i} gap="sm" wrap="nowrap">
          <Skeleton circle height={34} />
          <Box style={{ flex: 1 }}>
            <Skeleton height={12} width="35%" radius="sm" />
            <Skeleton height={10} width="55%" mt={6} radius="sm" />
          </Box>
          <Skeleton height={26} width={80} radius="sm" />
        </Group>
      ))}
    </Stack>
  );
}

export default function AccessPage() {
  const { status } = useSession();
  const { data, isLoading, isError, error, refetch, isFetching } = useApiTokens();
  // The new token's secret lives only here, never in the query cache
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  if (status === 'unauthenticated') {
    return (
      <Container size="md" py="xl">
        <SignInPrompt
          title="CLI and MCP access"
          message="Sign in to create tokens for the TimDo command line and AI assistants."
        />
      </Container>
    );
  }

  const tokens = Array.isArray(data) ? data : [];

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <Box>
          <Title order={1}>CLI and MCP access</Title>
          <Text c="dimmed" size="sm" maw={600}>
            Tokens let the TimDo command line and AI assistants (MCP) act as you. They can see and
            change exactly what you can in the web app, nothing more. Treat a token like a password.
          </Text>
        </Box>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={2} size="h4">
              Your tokens
            </Title>

            {status === 'loading' || isLoading ? (
              <TokenSkeleton />
            ) : isError ? (
              <Alert color="red" variant="light" title="Couldn't load your tokens">
                <Text size="sm" mb="xs">
                  {(error as Error)?.message || 'Something went wrong.'}
                </Text>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  leftSection={<IconRefresh size={14} />}
                  onClick={() => refetch()}
                  loading={isFetching}
                >
                  Try again
                </Button>
              </Alert>
            ) : (
              <TokenList tokens={tokens} />
            )}

            <Divider />

            <CreateTokenForm onCreated={setCreated} />

            {created && <NewTokenPanel created={created} onDismiss={() => setCreated(null)} />}
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Title order={2} size="h4" mb="md">
            Set up the CLI and MCP
          </Title>
          <SetupSteps />
        </Card>

        <Group gap="xs" wrap="nowrap" align="center">
          <IconBrandGithub size={18} aria-hidden style={{ flexShrink: 0 }} />
          <Text size="sm" c="dimmed">
            <Anchor href={REPO_URL} target="_blank" rel="noopener noreferrer">
              Source code on GitHub
            </Anchor>
            , AGPL-3.0. Contributions welcome.
          </Text>
        </Group>
      </Stack>
    </Container>
  );
}
