'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconMicrophone, IconPlayerStopFilled } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { ActionIcon, Loader, NavLink } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { apiFetch } from '../../app/lib/apiClient';
import { getWorkerApiBaseUrl } from '../../app/lib/apiConfig';
import {
  captureTaskCacheScope,
  isTaskCacheScopeCurrent,
  type TaskCacheScope,
} from '../../app/lib/taskCache';
import { RecordingToolbar } from './RecordingToolbar';
import { createVoiceReview, saveVoiceReview, type VoiceCommandResult } from './voiceTypes';
import classes from './VoiceCommand.module.css';

type RecordingStatus = 'idle' | 'recording' | 'processing';

const MAX_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

interface VoiceCommandProps {
  compact?: boolean;
}

interface VoiceGeneration {
  id: number;
  accountId: string;
  scope: TaskCacheScope;
}

interface VoiceMutationVariables {
  formData: FormData;
  accessToken: string;
  generation: VoiceGeneration;
}

export function VoiceCommand({ compact = false }: VoiceCommandProps) {
  const { data: session, status: sessionStatus } = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const accountId = session?.user?.id || session?.user?.email || null;
  const authRef = useRef({
    status: sessionStatus,
    accountId,
    accessToken: session?.accessToken ?? null,
  });
  authRef.current = {
    status: sessionStatus,
    accountId,
    accessToken: session?.accessToken ?? null,
  };

  const [status, setStatus] = useState<RecordingStatus>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mimeTypeRef = useRef<string>('audio/webm');
  const streamRef = useRef<MediaStream | null>(null);
  const generationRef = useRef<VoiceGeneration | null>(null);
  const generationIdRef = useRef(0);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const isGenerationCurrent = useCallback(
    (generation: VoiceGeneration) =>
      generationRef.current?.id === generation.id &&
      authRef.current.status === 'authenticated' &&
      authRef.current.accountId === generation.accountId &&
      isTaskCacheScopeCurrent(queryClient, generation.scope),
    [queryClient]
  );

  useEffect(() => {
    const generation = generationRef.current;
    if (!generation || isGenerationCurrent(generation)) {
      return;
    }

    generationRef.current = null;
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    releaseStream();
    setStatus('idle');
  }, [accountId, sessionStatus, isGenerationCurrent, releaseStream]);

  const voiceCommandMutation = useMutation<VoiceCommandResult, Error, VoiceMutationVariables>({
    mutationFn: async ({ formData, accessToken, generation }) => {
      if (!isGenerationCurrent(generation)) {
        throw new Error('The signed-in account changed. Try recording again.');
      }
      const response = await apiFetch(`${getWorkerApiBaseUrl()}/ai/voice-command`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
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
    onSuccess: (data, variables) => {
      if (!isGenerationCurrent(variables.generation)) {
        return;
      }
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

      const review = createVoiceReview(data, variables.generation.accountId);
      if (!review || !isGenerationCurrent(variables.generation)) {
        return;
      }

      // Keep private review content in this tab, never in browser history or copied URLs.
      if (!saveVoiceReview(review)) {
        notifications.show({
          title: 'Review unavailable',
          message:
            'Your browser could not store the review. No task changes were made. Check site storage settings and try again.',
          color: 'red',
          autoClose: false,
        });
        return;
      }
      router.push('/board/review-changes');
    },
    onError: (error, variables) => {
      if (!isGenerationCurrent(variables.generation)) {
        return;
      }
      notifications.show({
        title: 'Voice Command Failed',
        message: error.message,
        color: 'red',
      });
    },
    onSettled: (_data, _error, variables) => {
      if (generationRef.current?.id === variables.generation.id) {
        generationRef.current = null;
        setStatus('idle');
      }
    },
  });

  const stopRecording = () => {
    if (mediaRecorderRef.current && status === 'recording') {
      mediaRecorderRef.current.stop();
      // The onstop event handler will take care of the rest
    }
  };

  const startRecording = async () => {
    const auth = authRef.current;
    if (auth.status !== 'authenticated' || !auth.accountId || !auth.accessToken) {
      notifications.show({
        title: 'Not signed in',
        message: 'Sign in and try again.',
        color: 'red',
      });
      return;
    }

    const generation: VoiceGeneration = {
      id: ++generationIdRef.current,
      accountId: auth.accountId,
      scope: captureTaskCacheScope(queryClient, auth.accountId),
    };
    generationRef.current = generation;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 }, // Mono audio
      });
      if (!isGenerationCurrent(generation)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

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
        if (!isGenerationCurrent(generation) || event.data.size <= 0) {
          return;
        }
        audioChunksRef.current.push(event.data);
        currentSize += event.data.size;
        // Check for file size limit on each data chunk.
        if (currentSize > MAX_FILE_SIZE_BYTES) {
          mediaRecorderRef.current?.stop();
          notifications.show({
            title: 'Recording Stopped',
            message: 'Maximum file size of 10MB reached.',
            color: 'orange',
          });
        }
      };

      mediaRecorderRef.current.onstop = () => {
        if (!isGenerationCurrent(generation)) {
          return;
        }
        if (recordingTimeoutRef.current) {
          clearTimeout(recordingTimeoutRef.current);
          recordingTimeoutRef.current = null;
        }

        // Stop all tracks to release the microphone
        releaseStream();

        const accessToken = authRef.current.accessToken;
        if (!accessToken) {
          generationRef.current = null;
          setStatus('idle');
          notifications.show({
            title: 'Not signed in',
            message: 'Sign in and try again.',
            color: 'red',
          });
          return;
        }

        const audioBlob = new Blob(audioChunksRef.current, {
          type: mimeTypeRef.current,
        });
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        setStatus('processing');
        voiceCommandMutation.mutate({ formData, accessToken, generation });
      };

      mediaRecorderRef.current.start(1000); // ondataavailable will be called every second
      setStatus('recording');

      // Recording will automatically stop after 3 minutes.
      recordingTimeoutRef.current = setTimeout(() => {
        if (!isGenerationCurrent(generation)) {
          return;
        }
        mediaRecorderRef.current?.stop();
        notifications.show({
          title: 'Recording Stopped',
          message: 'Maximum duration of 3 minutes reached.',
          color: 'orange',
        });
      }, MAX_DURATION_MS);
    } catch (_error) {
      const isCurrent = isGenerationCurrent(generation);
      if (generationRef.current?.id === generation.id) {
        generationRef.current = null;
      }
      if (isCurrent) {
        setStatus('idle');
        notifications.show({
          title: 'Microphone Error',
          message: 'Could not access the microphone. Please check permissions.',
          color: 'red',
        });
      }
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
