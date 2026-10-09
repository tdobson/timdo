'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconMicrophone, IconPlayerStopFilled } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { ActionIcon, Loader, NavLink } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useInstanceConfig } from '../../app/hooks/useInstanceConfig';
import { apiFetch } from '../../app/lib/apiClient';
import { getWorkerApiBaseUrl } from '../../app/lib/apiConfig';
import type { Project } from '../../app/types/project.types';
import { RecordingToolbar } from './RecordingToolbar';
import { saveVoiceReview, type VoiceCommandResult } from './voiceTypes';
import classes from './VoiceCommand.module.css';

type RecordingStatus = 'idle' | 'recording' | 'processing';

const MAX_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

interface VoiceCommandProps {
  compact?: boolean;
}

export function VoiceCommand({ compact = false }: VoiceCommandProps) {
  const { data: session } = useSession();
  const { features } = useInstanceConfig();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mimeTypeRef = useRef<string>('audio/webm');
  const streamRef = useRef<MediaStream | null>(null);

  const voiceCommandMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      const response = await apiFetch(`${getWorkerApiBaseUrl()}/ai/voice-command`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: formData,
      });
      if (!response.ok) {
        const errorData = (await response.json().catch(() => null)) as {
          error?: string;
          details?: string;
        } | null;
        throw new Error(errorData?.error || 'Failed to process voice command');
      }
      return (await response.json()) as VoiceCommandResult;
    },
    onSuccess: (data) => {
      const { proposedChanges, summary, answer, warnings = [] } = data;

      // Questions ("What's Robin working on?") come back as an answer
      if (answer) {
        notifications.show({
          title: 'Answer',
          message: answer,
          color: 'blue',
          autoClose: 15000,
        });
      }

      if (!proposedChanges || proposedChanges.length === 0) {
        if (warnings.length > 0) {
          notifications.show({
            title: 'Nothing changed',
            message: warnings.join(' '),
            color: 'yellow',
            autoClose: 12000,
          });
        } else if (!answer) {
          notifications.show({
            title: 'No changes suggested',
            message: summary || "I couldn't work out any changes from that. Try again?",
            color: 'yellow',
          });
        }
        return;
      }

      // Hand the full result (warnings, people, workspaces) to the review screen
      if (saveVoiceReview(data)) {
        router.push('/board/review-changes');
      } else {
        const changesParam = encodeURIComponent(JSON.stringify(proposedChanges));
        router.push(`/board/review-changes?changes=${changesParam}`);
      }
    },
    onError: (error) => {
      notifications.show({
        title: 'Voice Command Failed',
        message: error.message,
        color: 'red',
      });
    },
    onSettled: () => {
      setStatus('idle');
    },
  });

  const stopRecording = () => {
    if (mediaRecorderRef.current && status === 'recording') {
      mediaRecorderRef.current.stop();
      // The onstop event handler will take care of the rest
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 }, // Mono audio
      });

      streamRef.current = stream;
      // Request mono audio at a lower bitrate to keep file sizes small and uploads fast.
      // Use audio/webm if supported, otherwise fall back to what the browser supports
      let mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        // Try common alternatives for iOS and other browsers
        const alternatives = ['audio/mp4', 'audio/wav', 'audio/ogg'];
        const supported = alternatives.find((type) => MediaRecorder.isTypeSupported(type));
        mimeType = supported || '';
      }

      mediaRecorderRef.current = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 64000, // 64 kbps
      });
      mimeTypeRef.current = mimeType;
      audioChunksRef.current = [];
      let currentSize = 0;

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          currentSize += event.data.size;
          // Check for file size limit on each data chunk.
          if (currentSize > MAX_FILE_SIZE_BYTES) {
            stopRecording();
            notifications.show({
              title: 'Recording Stopped',
              message: 'Maximum file size of 10MB reached.',
              color: 'orange',
            });
          }
        }
      };

      mediaRecorderRef.current.onstop = () => {
        if (recordingTimeoutRef.current) {
          clearTimeout(recordingTimeoutRef.current);
          recordingTimeoutRef.current = null;
        }

        // Stop all tracks to release the microphone
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        const audioBlob = new Blob(audioChunksRef.current, {
          type: mimeTypeRef.current,
        });
        // The cached task list saves the server a read; it loads its own if this is missing
        const projects = queryClient.getQueryData<Project[]>(['projects']);

        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
        if (projects) {
          formData.append('projects', JSON.stringify(projects));
        }

        setStatus('processing');
        voiceCommandMutation.mutate(formData);
      };

      mediaRecorderRef.current.start(1000); // ondataavailable will be called every second
      setStatus('recording');

      // Recording will automatically stop after 3 minutes.
      recordingTimeoutRef.current = setTimeout(() => {
        stopRecording();
        notifications.show({
          title: 'Recording Stopped',
          message: 'Maximum duration of 3 minutes reached.',
          color: 'orange',
        });
      }, MAX_DURATION_MS);
    } catch (_error) {
      notifications.show({
        title: 'Microphone Error',
        message: 'Could not access the microphone. Please check permissions.',
        color: 'red',
      });
    }
  };

  const handleClick = () => {
    if (status === 'processing') {
      return;
    }
    if (status === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Nothing to offer on an instance that has switched voice commands off
  if (!features.voice) {
    return null;
  }

  if (compact) {
    // Mobile-friendly compact version (just an icon button)
    return (
      <>
        <ActionIcon
          onClick={handleClick}
          disabled={status === 'processing'}
          size="lg"
          variant={status === 'recording' ? 'filled' : 'subtle'}
          color={status === 'recording' ? 'red' : 'gray'}
          className={status === 'recording' ? classes.pulse : undefined}
          aria-label="Voice Command"
        >
          {status === 'processing' ? (
            <Loader size="sm" />
          ) : status === 'recording' ? (
            <IconPlayerStopFilled size={20} />
          ) : (
            <IconMicrophone size={20} />
          )}
        </ActionIcon>
        <RecordingToolbar
          isRecording={status === 'recording'}
          onStopRecording={stopRecording}
          onClose={stopRecording}
        />
      </>
    );
  }

  // Desktop sidebar version
  const getRightSection = () => {
    if (status === 'processing') {
      return <Loader size="1rem" />;
    }
    if (status === 'recording') {
      return (
        <ActionIcon
          variant="transparent"
          color="red"
          onClick={stopRecording}
          className={classes.pulse}
        >
          <IconPlayerStopFilled size="1rem" />
        </ActionIcon>
      );
    }
    return null;
  };

  return (
    <>
      <NavLink
        label="Voice Command"
        description={
          status === 'recording' ? 'Recording... Click stop when done.' : 'Click anywhere to start'
        }
        onClick={handleClick}
        disabled={status === 'processing'}
        leftSection={
          <ActionIcon
            variant="transparent"
            color={status === 'recording' ? 'red' : 'gray'}
            disabled={status === 'processing'}
          >
            <IconMicrophone size="1rem" stroke={1.5} />
          </ActionIcon>
        }
        rightSection={getRightSection()}
      />
      <RecordingToolbar
        isRecording={status === 'recording'}
        onStopRecording={stopRecording}
        onClose={stopRecording}
      />
    </>
  );
}
