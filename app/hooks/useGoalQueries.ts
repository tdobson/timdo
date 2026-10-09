import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { notifications } from '@mantine/notifications';
import { createGoal, deleteGoal, getGoals, updateGoal } from '../lib/apiClient';
import type { Goal, GoalCreateInput, GoalType, GoalUpdateInput } from '../types/goal.types';
import { useInstanceConfig } from './useInstanceConfig';

// Query key factory
export const goalKeys = {
  all: ['goals'] as const,
  lists: () => [...goalKeys.all, 'list'] as const,
  list: (type?: GoalType) => [...goalKeys.lists(), { type }] as const,
};

/**
 * Fetch all goals for current user (optional type filter)
 */
export function useGoals(type?: GoalType) {
  const { data: session } = useSession();
  const { features } = useInstanceConfig();

  return useQuery({
    queryKey: goalKeys.list(type),
    queryFn: () => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return getGoals(type, session.accessToken);
    },
    enabled: !!session?.accessToken && features.goals,
  });
}

/**
 * Mutation hook to create a new goal
 */
export function useCreateGoal() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  return useMutation({
    mutationFn: (newGoal: GoalCreateInput) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return createGoal(newGoal, session.accessToken);
    },
    onSuccess: (createdGoal) => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
      notifications.show({
        title: 'Goal Created',
        message: `Successfully created "${createdGoal.title}"`,
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: 'Error',
        message: error.message || 'Failed to create goal',
        color: 'red',
      });
    },
  });
}

/**
 * Mutation hook to update a goal
 */
export function useUpdateGoal() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  return useMutation({
    mutationFn: (variables: { goalId: string; data: GoalUpdateInput }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return updateGoal(variables.goalId, variables.data, session.accessToken);
    },
    onMutate: async ({ goalId, data }) => {
      await queryClient.cancelQueries({ queryKey: goalKeys.all });
      const previousGoals = queryClient.getQueryData<Goal[]>(goalKeys.list());

      if (previousGoals) {
        queryClient.setQueryData<Goal[]>(
          goalKeys.list(),
          previousGoals.map((g) => (g.id === goalId ? { ...g, ...data } : g))
        );
      }

      return { previousGoals };
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previousGoals) {
        queryClient.setQueryData(goalKeys.list(), context.previousGoals);
      }
      notifications.show({
        title: 'Error',
        message: error.message || 'Failed to update goal',
        color: 'red',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
    },
    onSuccess: (updatedGoal) => {
      notifications.show({
        title: 'Goal Updated',
        message: `Successfully updated "${updatedGoal.title}"`,
        color: 'green',
      });
    },
  });
}

/**
 * Mutation hook to delete a goal
 */
export function useDeleteGoal() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  return useMutation({
    mutationFn: (goalId: string) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return deleteGoal(goalId, session.accessToken);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: goalKeys.all });
      notifications.show({
        title: 'Goal Deleted',
        message: 'Goal was successfully deleted',
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: 'Error',
        message: error.message || 'Failed to delete goal',
        color: 'red',
      });
    },
  });
}
