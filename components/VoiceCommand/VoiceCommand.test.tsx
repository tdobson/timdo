import React from 'react';
import { screen } from '@testing-library/react';
import { render } from '../../test-utils';
import { VoiceCommand } from './VoiceCommand';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

const mockUseAiStatus = jest.fn();
jest.mock('../../app/hooks/useAiStatus', () => ({
  useAiStatus: () => mockUseAiStatus(),
}));

describe('VoiceCommand', () => {
  it('shows the microphone when the instance has an AI provider', () => {
    mockUseAiStatus.mockReturnValue({ voiceAvailable: true, status: null, isLoading: false });
    render(<VoiceCommand />);
    expect(screen.getByText('Voice Command')).toBeInTheDocument();
  });

  it('shows nothing when the API says voice is not configured', () => {
    mockUseAiStatus.mockReturnValue({
      voiceAvailable: false,
      status: {
        configured: false,
        transcription: null,
        llm: null,
        missing: 'GROQ_API_KEY is not set',
      },
      isLoading: false,
    });
    render(<VoiceCommand compact />);
    expect(screen.queryByLabelText('Voice Command')).not.toBeInTheDocument();
    expect(screen.queryByText('Voice Command')).not.toBeInTheDocument();
  });

  it('keeps the control while the status is still loading', () => {
    mockUseAiStatus.mockReturnValue({ voiceAvailable: true, status: null, isLoading: true });
    render(<VoiceCommand compact />);
    expect(screen.getByLabelText('Voice Command')).toBeInTheDocument();
  });
});
