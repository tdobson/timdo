import { useQuery } from '@tanstack/react-query';
import { getWorkerApiBaseUrl } from '../lib/apiConfig';

export type FeatureName = 'goals' | 'poster' | 'voice' | 'gmail';
export type Features = Record<FeatureName, boolean>;

/** What `GET /api/v2/config` returns: how this instance is set up. Public, nothing secret. */
export interface InstanceConfigResponse {
  name: string;
  appUrl: string;
  inviteBaseUrl: string;
  features: Features;
}

export const ALL_FEATURES: Features = { goals: true, poster: true, voice: true, gmail: true };

export const instanceConfigKeys = {
  config: ['instance', 'config'] as const,
};

export async function fetchInstanceConfig(): Promise<InstanceConfigResponse> {
  const response = await fetch(`${getWorkerApiBaseUrl()}/config`);
  if (!response.ok) {
    throw new Error('Could not read the instance settings');
  }
  return (await response.json()) as InstanceConfigResponse;
}

/**
 * The instance's settings and feature switches. Until the answer arrives, or if the request
 * fails, every feature counts as on, so a hiccup never hides part of the app; things only
 * disappear when the API says they are switched off.
 */
export function useInstanceConfig() {
  const query = useQuery<InstanceConfigResponse>({
    queryKey: instanceConfigKeys.config,
    queryFn: fetchInstanceConfig,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  return {
    config: query.data ?? null,
    features: query.data?.features ?? ALL_FEATURES,
    isLoading: query.isLoading,
  };
}
