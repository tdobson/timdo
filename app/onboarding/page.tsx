'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { OnboardingProcessing } from '../../components/Onboarding/OnboardingProcessing';
import { OnboardingReview } from '../../components/Onboarding/OnboardingReview';
import { OnboardingTypingForm } from '../../components/Onboarding/OnboardingTypingForm';
import { OnboardingWelcome } from '../../components/Onboarding/OnboardingWelcome';
import { useInstanceConfig } from '../hooks/useInstanceConfig';
import { useOnboardingRecording } from '../hooks/useOnboardingRecording';
import { useCreateProject } from '../hooks/useProjectMutations';
import type { ProjectCreateInput } from '../types/project.types';

type OnboardingStep = 'welcome' | 'processing' | 'review' | 'typing';

export default function OnboardingPage() {
  const { status: sessionStatus } = useSession();
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [projects, setProjects] = useState<ProjectCreateInput[]>([]);
  const [isCreatingProjects, setIsCreatingProjects] = useState(false);

  const {
    status: recordingStatus,
    microphoneAvailable,
    parsedProjects,
    startRecording,
    stopRecording,
  } = useOnboardingRecording();

  const createProjectMutation = useCreateProject();
  const { features } = useInstanceConfig();

  // Switch to the typing form if there is no microphone, or voice is off on this instance
  useEffect(() => {
    if ((microphoneAvailable === false || !features.voice) && step === 'welcome') {
      setStep('typing');
    }
  }, [microphoneAvailable, features.voice, step]);

  // When parsing completes and we get parsed projects, move to review
  useEffect(() => {
    if (
      parsedProjects &&
      recordingStatus === 'idle' &&
      (step === 'welcome' || step === 'processing')
    ) {
      setProjects(parsedProjects);
      setStep('review');
    }
  }, [parsedProjects, recordingStatus, step]);

  // Show processing screen during recording
  useEffect(() => {
    if (recordingStatus === 'processing') {
      setStep('processing');
    }
  }, [recordingStatus]);

  const handleTypingComplete = (typedProjects: ProjectCreateInput[]) => {
    setProjects(typedProjects);
    setStep('review');
  };

  const handleContinue = async () => {
    setIsCreatingProjects(true);
    try {
      // Create projects one by one
      for (const project of projects) {
        await new Promise<void>((resolve, reject) => {
          createProjectMutation.mutate(project, {
            onSuccess: () => resolve(),
            onError: (error) => reject(error),
          });
        });
      }

      notifications.show({
        title: 'Welcome to TimDo!',
        message: 'Your projects have been added to your board.',
        color: 'green',
      });

      router.push('/board');
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: 'Failed to create some projects. Please try again.',
        color: 'red',
      });
      setIsCreatingProjects(false);
    }
  };

  if (sessionStatus === 'loading') {
    return (
      <div
        style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}
      >
        <Loader />
      </div>
    );
  }

  if (sessionStatus === 'unauthenticated') {
    router.push('/');
    return null;
  }

  if (isCreatingProjects) {
    return <OnboardingProcessing />;
  }

  if (step === 'welcome') {
    return (
      <OnboardingWelcome
        isRecording={recordingStatus === 'recording'}
        onStartRecording={startRecording}
        onStopRecording={stopRecording}
      />
    );
  }

  if (step === 'processing') {
    return <OnboardingProcessing />;
  }

  if (step === 'typing') {
    return <OnboardingTypingForm onComplete={handleTypingComplete} />;
  }

  if (step === 'review') {
    return (
      <OnboardingReview
        projects={projects}
        onProjectsChange={setProjects}
        onContinue={handleContinue}
      />
    );
  }

  return null;
}
