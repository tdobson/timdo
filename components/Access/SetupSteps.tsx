'use client';

import React from 'react';
import { Box, Code, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { INSTANCE } from '../../app/lib/instance';
import { CommandBlock } from './CommandBlock';

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Group component="li" gap="md" wrap="nowrap" align="flex-start" style={{ listStyle: 'none' }}>
      <ThemeIcon variant="light" radius="xl" size="md" aria-hidden>
        <Text size="xs" fw={700}>
          {number}
        </Text>
      </ThemeIcon>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Title order={3} size="h5" mb={6}>
          {title}
        </Title>
        <Stack gap="xs">{children}</Stack>
      </Box>
    </Group>
  );
}

const USEFUL_COMMANDS: Array<{ command: string; what: string }> = [
  { command: 'bin/timdo list do --mine', what: 'Your tasks to do now' },
  { command: 'bin/timdo activity -n 20', what: 'The last 20 things that happened' },
  { command: 'bin/timdo ws list', what: 'The workspaces you are in' },
];

export function SetupSteps() {
  return (
    <Stack gap="lg" component="ol" m={0} p={0} aria-label="Setup steps">
      <Step number={1} title="Get the code">
        <CommandBlock value={`git clone ${INSTANCE.repoUrl}.git && cd timdo`} />
        <Text size="sm" c="dimmed">
          You&apos;ll need bash, curl and jq.
        </Text>
      </Step>

      <Step number={2} title="Log in the CLI">
        <CommandBlock value="bin/timdo login" />
        <Text size="sm" c="dimmed">
          Paste your token when it asks. Then check it worked:
        </Text>
        <CommandBlock value="bin/timdo whoami" />
      </Step>

      <Step number={3} title="Add the MCP server">
        <Text size="sm" c="dimmed">
          For Claude Code, run these from the timdo folder:
        </Text>
        <CommandBlock value="cd mcp && npm install && cd .." />
        <CommandBlock value='claude mcp add timdo -- node "$(pwd)/mcp/index.js"' />
        <Text size="sm" c="dimmed">
          Other MCP clients: set the command to <Code>node</Code> and the args to{' '}
          <Code>[&lt;path&gt;/mcp/index.js]</Code>. It uses the login from step 2.
        </Text>
      </Step>

      <Step number={4} title="Useful commands">
        {USEFUL_COMMANDS.map(({ command, what }) => (
          <Box key={command}>
            <Text size="sm" c="dimmed" mb={4}>
              {what}
            </Text>
            <CommandBlock value={command} />
          </Box>
        ))}
      </Step>
    </Stack>
  );
}
