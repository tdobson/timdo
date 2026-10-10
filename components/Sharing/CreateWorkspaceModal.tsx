'use client';

import React, { useState } from 'react';
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useCreateWorkspace } from '../../app/hooks/useSharingQueries';

export function CreateWorkspaceModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const create = useCreateWorkspace();

  const close = () => {
    setName('');
    onClose();
  };

  return (
    <Modal opened={opened} onClose={close} title="New shared workspace" centered radius="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            create.mutate(name.trim(), { onSuccess: close });
          }
        }}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            A workspace is a group of people and projects. Everyone in it sees all of its projects,
            epics and tasks. Your life goals always stay private.
          </Text>
          <TextInput
            label="Name"
            placeholder="e.g. Northstar Workshop"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={80}
            required
            data-autofocus
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={close} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create workspace
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
