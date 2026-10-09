import { IconPlayerStopFilled } from '@tabler/icons-react';
import { Button, Modal, Stack, Text, Title } from '@mantine/core';

interface VoiceCommandGuideProps {
  opened: boolean;
  onClose: () => void;
  isRecording: boolean;
  onStopRecording: () => void;
}

export function VoiceCommandGuide({
  opened,
  onClose,
  isRecording,
  onStopRecording,
}: VoiceCommandGuideProps) {
  const handleClose = () => {
    if (!isRecording) {
      onClose();
    }
  };

  const handleStopRecording = () => {
    onStopRecording();
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      closeOnClickOutside={!isRecording}
      closeOnEscape={!isRecording}
      withCloseButton={!isRecording}
      title={<Title order={3}>Voice Command</Title>}
      size="md"
      centered
    >
      <Stack gap="md">
        {isRecording ? (
          <>
            <Text size="lg" fw={600} ta="center" c="red">
              Recording...
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              Speak naturally. You can add, change, assign or delete tasks, or ask about them.
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              Try &ldquo;Add an Acme Solar task for Robin to check the inverter datasheet&rdquo; or
              &ldquo;Assign the Acme Solar onboarding task to me&rdquo;.
            </Text>
            <Button
              fullWidth
              size="lg"
              color="red"
              onClick={handleStopRecording}
              leftSection={<IconPlayerStopFilled />}
              mt="md"
            >
              Stop recording
            </Button>
          </>
        ) : (
          <>
            <Text size="sm" c="dimmed" ta="center">
              Done. Check each change on the next screen before it's made.
            </Text>
            <Button fullWidth onClick={onClose} mt="md">
              Close
            </Button>
          </>
        )}
      </Stack>
    </Modal>
  );
}
