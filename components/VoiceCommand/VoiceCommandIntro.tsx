'use client';

import { useEffect, useState } from 'react';
import { Button, List, Modal, Text, Title } from '@mantine/core';

export const TASK_EXAMPLES = [
  'Move Fix inverter alarm to done',
  'Set the priority of Renew passport to 8',
  'Snooze the Acme Solar report until next Monday',
];

export const TEAM_EXAMPLES = [
  'Add an Acme Solar task for Robin to check the inverter datasheet',
  'Assign the Acme Solar onboarding task to me',
  "What's Robin working on?",
];

// v2: shown once more so existing users see the shared-workspace examples
const INTRO_SHOWN_KEY = 'voice-command-intro-shown-v2';

export function VoiceCommandIntro() {
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    // Check if intro has been shown before
    const hasBeenShown = localStorage.getItem(INTRO_SHOWN_KEY);
    if (!hasBeenShown) {
      setOpened(true);
    }
  }, []);

  const handleClose = () => {
    localStorage.setItem(INTRO_SHOWN_KEY, 'true');
    setOpened(false);
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={<Title order={3}>Voice commands</Title>}
      size="md"
      centered
    >
      <Text mb="md">
        Talk to your board. Say what you want changed and you'll get to check each change before
        it's made.
      </Text>

      <Title order={4} size="h5" mb="xs">
        Your tasks
      </Title>
      <List mb="md" spacing="xs">
        {TASK_EXAMPLES.map((example) => (
          <List.Item key={example}>
            <Text fw={500}>&ldquo;{example}&rdquo;</Text>
          </List.Item>
        ))}
      </List>

      <Title order={4} size="h5" mb="xs">
        Working with others
      </Title>
      <List mb="md" spacing="xs">
        {TEAM_EXAMPLES.map((example) => (
          <List.Item key={example}>
            <Text fw={500}>&ldquo;{example}&rdquo;</Text>
          </List.Item>
        ))}
      </List>

      <Text size="sm" c="dimmed" mb="lg">
        You can assign tasks to anyone in the same workspace as the project. Projects you can only
        view are left alone. When you start recording, a toolbar appears at the top, so you can
        scroll your board while you talk. Press Stop when you're done.
      </Text>

      <Button onClick={handleClose}>Got it</Button>
    </Modal>
  );
}

// Export function to manually show the intro (for help button)
export function showVoiceCommandIntro() {
  localStorage.removeItem(INTRO_SHOWN_KEY);
  window.location.reload(); // Simple way to trigger the intro again
}
