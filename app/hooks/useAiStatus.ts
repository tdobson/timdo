import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { apiFetch } from '../lib/apiClient';
import { getWorkerApiBaseUrl } from '../lib/apiConfig';

export interface AiServiceStatus {
  provider: string;
  model: string;
  ready: boolean;
}

/** What `GET /api/v2/ai/status` returns: which AI services this instance uses, names only. */
export interface AiStatus {
  configured: boolean;
  transcription: AiServiceStatus | null;
  llm: AiServiceStatus | null;
  missing: string | null;
}

export const aiStatusKeys = {
  status: ['ai', 'status'] as const,
};

export async function fetchAiStatus(token: string): Promise<AiStatus> {
  const response = await apiFetch(`${getWorkerApiBaseUrl()}/ai/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error('Could not read the AI status');
  }
  return (await response.json()) as AiStatus;
}

/**
 * Whether voice features work on this instance. Until the answer arrives, or if the request
 * fails, `voiceAvailable` is true so the controls are not hidden by a hiccup; they are only
 * hidden when the API says plainly that nothing is configured.
 */
export function useAiStatus() {
  const { data: session } = useSession();
  const token = session?.accessToken;

  const query = useQuery<AiStatus>({
    queryKey: aiStatusKeys.status,
    queryFn: () => fetchAiStatus(token as string),
    enabled: !!token,
    staleTime: 10 * 60 * 1000,
  });

  return {
    status: query.data ?? null,
    voiceAvailable: query.data ? query.data.configured : true,
    isLoading: query.isLoading,
  };
}
