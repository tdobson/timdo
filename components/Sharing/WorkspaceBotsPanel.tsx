'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { activityKeys } from '../../app/hooks/useActivityQueries';
import { botKeys, useBotList } from '../../app/hooks/useBotQueries';
import { organisationKeys } from '../../app/hooks/useOrganisationQueries';
import { sharingKeys } from '../../app/hooks/useSharingQueries';
import {
  CollaborationApiError,
  createBot,
  createBotToken,
  disableBot,
  revokeBotToken,
  updateBot,
} from '../../app/lib/collaborationApi';
import type {
  BotRole,
  BotTokenSummary,
  BotView,
  CreatedBotResult,
  CreatedBotToken,
  SharingWorkspace,
} from '../../app/types/collaboration.types';
import { BotMarker } from '../Team/BotMarker';
import { ConfirmModal } from './ConfirmModal';
import { ROLE_LABELS, workspaceLabel } from './sharingRules';

type RequestContext = {
  key: string;
  accountId: string;
  orgId: string;
  mounted: boolean;
};

type RequestCapture = { context: RequestContext; generation: number };
type PendingAction =
  | { type: 'disable'; bot: BotView }
  | { type: 'revoke'; bot: BotView; token: BotTokenSummary }
  | null;
type OneTimeSecret = {
  value: string;
  label: string;
  context: RequestContext;
  generation: number;
};

const CREATE_RECOVERY =
  'The request may have created the bot or token, but its response was lost. Refresh the list. If it exists, revoke the credential and issue a replacement. The secret cannot be recovered, and the request will not be repeated automatically.';

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Something went wrong. Please try again.';
}

function isConflict(error: unknown): boolean {
  return error instanceof CollaborationApiError && error.status === 409;
}

function isUncertainCredentialOutcome(error: unknown): boolean {
  return !(error instanceof CollaborationApiError) || error.status >= 500;
}

function lastUsedLabel(value: string | null): string {
  if (!value) {
    return 'Never used';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Last use unavailable'
    : `Last used ${date.toLocaleString('en-GB')}`;
}

export function WorkspaceBotsPanel({ workspace }: { workspace: SharingWorkspace }) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const accountId = session?.user?.id || session?.user?.email || null;
  const client = useQueryClient();
  const manager =
    !workspace.isPersonal && (workspace.role === 'owner' || workspace.role === 'admin');
  const list = useBotList(workspace);
  const contextKey = `${accountId || 'signed-out'}:${workspace.id}`;
  const contextRef = useRef<RequestContext>({
    key: contextKey,
    accountId: accountId || '',
    orgId: workspace.id,
    mounted: true,
  });
  if (contextRef.current.key !== contextKey) {
    contextRef.current = {
      key: contextKey,
      accountId: accountId || '',
      orgId: workspace.id,
      mounted: true,
    };
  }
  const generationRef = useRef(0);
  const secretGenerationRef = useRef(0);
  const copyGenerationRef = useRef(0);
  const busyRef = useRef(false);

  const [busy, setBusy] = useState(false);
  const [botName, setBotName] = useState('');
  const [initialTokenName, setInitialTokenName] = useState('initial');
  const [createRole, setCreateRole] = useState<BotRole>('member');
  const [editingNames, setEditingNames] = useState<Record<string, string>>({});
  const [tokenNames, setTokenNames] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<PendingAction>(null);

  useLayoutEffect(() => {
    const context = contextRef.current;
    context.mounted = true;
    busyRef.current = false;
    secretGenerationRef.current += 1;
    copyGenerationRef.current += 1;
    setBusy(false);
    setSecret(null);
    setCopyFeedback('');
    setError('');
    setNotice('');
    setPending(null);
    setBotName('');
    setInitialTokenName('initial');
    setCreateRole('member');
    setEditingNames({});
    setTokenNames({});
    return () => {
      context.mounted = false;
    };
  }, [contextKey]);

  const visibleSecret = secret?.context === contextRef.current ? secret : null;

  const showSecret = (value: string, label: string, context: RequestContext) => {
    const generation = ++secretGenerationRef.current;
    copyGenerationRef.current += 1;
    setCopyFeedback('');
    setSecret({ value, label, context, generation });
  };

  const captureRequest = (): RequestCapture | null => {
    if (!token || !accountId || !manager || busyRef.current) {
      return null;
    }
    busyRef.current = true;
    setBusy(true);
    const context = contextRef.current;
    generationRef.current += 1;
    return { context, generation: generationRef.current };
  };

  const isCurrent = (capture: RequestCapture) =>
    capture.context.mounted &&
    contextRef.current === capture.context &&
    generationRef.current === capture.generation;

  const finishRequest = (capture: RequestCapture) => {
    if (isCurrent(capture)) {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const refreshMetadata = async (capture: RequestCapture) => {
    const keys = [
      botKeys.list(capture.context.accountId, capture.context.orgId),
      sharingKeys.overview(capture.context.accountId),
      organisationKeys.members(capture.context.orgId, capture.context.accountId),
      activityKeys.account(capture.context.accountId),
    ];
    for (const queryKey of keys) {
      if (!isCurrent(capture)) {
        return;
      }
      await client.invalidateQueries({ queryKey });
    }
  };

  const handleCreateBot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (visibleSecret) {
      setError('Store or dismiss the displayed token before creating another credential.');
      return;
    }
    const name = botName.trim();
    const credentialName = initialTokenName.trim() || 'initial';
    if (!name || name.length > 80 || credentialName.length > 60) {
      setError('Enter a bot name up to 80 characters and a token name up to 60 characters.');
      return;
    }
    const capture = captureRequest();
    if (!capture) {
      return;
    }
    setError('');
    setNotice('');
    try {
      const result: CreatedBotResult = await createBot(
        capture.context.orgId,
        { name, role: createRole, tokenName: credentialName },
        token
      );
      if (!isCurrent(capture)) {
        return;
      }
      showSecret(result.token, `Initial token for ${result.bot.name}`, capture.context);
      setBotName('');
      setNotice(`${result.bot.name} is ready. Store this token now; it cannot be shown again.`);
      await refreshMetadata(capture);
    } catch (requestError) {
      if (!isCurrent(capture)) {
        return;
      }
      const uncertain = isUncertainCredentialOutcome(requestError);
      setError(uncertain ? CREATE_RECOVERY : readableError(requestError));
      if (uncertain) {
        await refreshMetadata(capture);
      }
    } finally {
      finishRequest(capture);
    }
  };

  const handleUpdateBot = async (bot: BotView, update: { name?: string; role?: BotRole }) => {
    const capture = captureRequest();
    if (!capture) {
      return;
    }
    setError('');
    setNotice('');
    try {
      const updated = await updateBot(capture.context.orgId, bot.id, update, token);
      if (!isCurrent(capture)) {
        return;
      }
      setNotice(
        updated.disabledAt
          ? `${bot.name} was disabled while this change was being saved. The latest state is shown below.`
          : 'Bot settings saved.'
      );
      if (update.name !== undefined) {
        setEditingNames((current) => {
          const next = { ...current };
          delete next[bot.id];
          return next;
        });
      }
      await refreshMetadata(capture);
    } catch (requestError) {
      if (!isCurrent(capture)) {
        return;
      }
      if (isConflict(requestError)) {
        await refreshMetadata(capture);
        if (isCurrent(capture)) {
          setEditingNames((current) => {
            const next = { ...current };
            delete next[bot.id];
            return next;
          });
          setError(
            'This bot changed in another request. The latest settings have been loaded. Review them before trying again.'
          );
        }
      } else {
        setError(readableError(requestError));
      }
    } finally {
      finishRequest(capture);
    }
  };

  const handleIssueToken = async (bot: BotView) => {
    if (visibleSecret) {
      setError('Store or dismiss the displayed token before creating another credential.');
      return;
    }
    const name = (tokenNames[bot.id] || 'CLI token').trim();
    if (!name || name.length > 60) {
      setError('Enter a token name up to 60 characters.');
      return;
    }
    const capture = captureRequest();
    if (!capture) {
      return;
    }
    setError('');
    setNotice('');
    try {
      const result: CreatedBotToken = await createBotToken(
        capture.context.orgId,
        bot.id,
        name,
        token
      );
      if (!isCurrent(capture)) {
        return;
      }
      showSecret(result.token, `Token for ${bot.name}`, capture.context);
      setNotice(`A new token for ${bot.name} is ready. Store it now; it cannot be shown again.`);
      await refreshMetadata(capture);
    } catch (requestError) {
      if (!isCurrent(capture)) {
        return;
      }
      const uncertain = isUncertainCredentialOutcome(requestError);
      setError(uncertain ? CREATE_RECOVERY : readableError(requestError));
      if (uncertain) {
        await refreshMetadata(capture);
      }
    } finally {
      finishRequest(capture);
    }
  };

  const confirmDestructiveAction = async () => {
    if (!pending) {
      return;
    }
    const action = pending;
    const capture = captureRequest();
    if (!capture) {
      return;
    }
    setError('');
    setNotice('');
    try {
      if (action.type === 'disable') {
        await disableBot(capture.context.orgId, action.bot.id, token);
      } else {
        await revokeBotToken(capture.context.orgId, action.bot.id, action.token.id, token);
      }
      if (!isCurrent(capture)) {
        return;
      }
      setPending(null);
      setNotice(
        action.type === 'disable'
          ? `${action.bot.name} has been disabled and its tokens revoked.`
          : `Token ${action.token.name} has been revoked.`
      );
      await refreshMetadata(capture);
    } catch (requestError) {
      if (!isCurrent(capture)) {
        return;
      }
      setError(readableError(requestError));
    } finally {
      finishRequest(capture);
    }
  };

  const dismissSecret = () => {
    secretGenerationRef.current += 1;
    copyGenerationRef.current += 1;
    setSecret(null);
    setCopyFeedback('');
  };

  const copySecret = async () => {
    if (!visibleSecret) {
      return;
    }
    const context = contextRef.current;
    const secretGeneration = visibleSecret.generation;
    const generation = ++copyGenerationRef.current;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard access is unavailable');
      }
      await navigator.clipboard.writeText(visibleSecret.value);
      if (
        contextRef.current !== context ||
        !context.mounted ||
        secretGenerationRef.current !== secretGeneration ||
        copyGenerationRef.current !== generation
      ) {
        return;
      }
      setCopyFeedback('Copied. Keep the token somewhere safe.');
    } catch {
      if (
        contextRef.current !== context ||
        !context.mounted ||
        secretGenerationRef.current !== secretGeneration ||
        copyGenerationRef.current !== generation
      ) {
        return;
      }
      setCopyFeedback('Clipboard access failed. Select the token above and copy it manually.');
    }
  };

  if (!manager) {
    return null;
  }

  return (
    <Paper
      component="section"
      withBorder
      radius="md"
      p="md"
      aria-label={`Bots in ${workspace.name}`}
    >
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
          <Box style={{ minWidth: 0, flex: '1 1 220px' }}>
            <Text fw={600} size="sm">
              Bots
            </Text>
            <Text size="xs" c="dimmed">
              Bots act as restricted identities in {workspaceLabel(workspace)}. Their tokens are
              shown once when issued.
            </Text>
          </Box>
          <Button
            size="xs"
            variant="light"
            onClick={() => list.refetch()}
            loading={list.isFetching}
            disabled={busy}
          >
            Refresh bot list
          </Button>
        </Group>

        {list.isPending && (
          <Text size="sm" role="status">
            Loading bots...
          </Text>
        )}
        {list.isError && (
          <Alert color="red" title="Couldn't load bots">
            <Text size="sm">{readableError(list.error)}</Text>
          </Alert>
        )}

        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {notice && (
          <Alert color="green" role="status">
            {notice}
          </Alert>
        )}

        {visibleSecret && (
          <Alert color="yellow" title={visibleSecret.label} aria-live="polite">
            <Stack gap="xs">
              <Text size="sm">
                This is the only time the full token will be shown. If you dismiss it before saving
                it, revoke the redacted token and issue a replacement.
              </Text>
              <TextInput
                aria-label="New bot token"
                value={visibleSecret.value}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                autoComplete="off"
                spellCheck={false}
              />
              <Group gap="xs" wrap="wrap">
                <Button size="xs" variant="light" onClick={copySecret}>
                  Copy token
                </Button>
                <Button size="xs" onClick={dismissSecret}>
                  I've stored it
                </Button>
              </Group>
              {copyFeedback && (
                <Text size="xs" role="status">
                  {copyFeedback}
                </Text>
              )}
            </Stack>
          </Alert>
        )}

        <form onSubmit={handleCreateBot}>
          <Stack gap="xs">
            <Group align="flex-end" gap="sm" wrap="wrap">
              <TextInput
                label="Bot name"
                value={botName}
                onChange={(event) => setBotName(event.currentTarget.value)}
                maxLength={80}
                required
                style={{ flex: '1 1 180px' }}
                disabled={busy}
              />
              <Select
                label="Bot role"
                value={createRole}
                onChange={(value) => value && setCreateRole(value as BotRole)}
                data={[
                  { value: 'member', label: 'Member' },
                  { value: 'viewer', label: 'Viewer' },
                ]}
                allowDeselect={false}
                style={{ flex: '1 1 140px' }}
                disabled={busy}
              />
              <TextInput
                label="Initial token name"
                value={initialTokenName}
                onChange={(event) => setInitialTokenName(event.currentTarget.value)}
                maxLength={60}
                style={{ flex: '1 1 150px' }}
                disabled={busy}
              />
              <Button
                type="submit"
                loading={busy}
                disabled={busy || !botName.trim() || !!visibleSecret}
              >
                Create bot
              </Button>
            </Group>
          </Stack>
        </form>

        {list.data?.length === 0 && !list.isFetching && (
          <Text size="sm" c="dimmed">
            No bots in this workspace yet.
          </Text>
        )}

        <Stack gap="sm">
          {(list.data || []).map((bot) => {
            const disabled = !!bot.disabledAt;
            const editableName = editingNames[bot.id] ?? bot.name;
            return (
              <Paper key={bot.id} withBorder radius="sm" p="sm" data-testid={`bot-row-${bot.id}`}>
                <Stack gap="sm">
                  <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
                    <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
                      <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
                        {bot.name}
                      </Text>
                      <BotMarker kind="bot" />
                      <Badge
                        color={disabled ? 'gray' : bot.role === 'viewer' ? 'gray' : 'teal'}
                        variant="light"
                      >
                        {disabled ? 'Disabled' : ROLE_LABELS[bot.role || 'member']}
                      </Badge>
                    </Group>
                    {!disabled && (
                      <Button
                        size="xs"
                        variant="light"
                        color="red"
                        onClick={() => setPending({ type: 'disable', bot })}
                        disabled={busy}
                        aria-label={`Disable ${bot.name}`}
                      >
                        Disable
                      </Button>
                    )}
                  </Group>

                  {bot.createdByName && (
                    <Text size="xs" c="dimmed">
                      Created by {bot.createdByName}
                    </Text>
                  )}

                  {!disabled && (
                    <Group align="flex-end" gap="xs" wrap="wrap">
                      <TextInput
                        label={`Name for ${bot.name}`}
                        value={editableName}
                        onChange={(event) =>
                          setEditingNames((current) => ({
                            ...current,
                            [bot.id]: event.currentTarget.value,
                          }))
                        }
                        maxLength={80}
                        style={{ flex: '1 1 180px' }}
                        disabled={busy}
                      />
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => handleUpdateBot(bot, { name: editableName.trim() })}
                        disabled={busy || !editableName.trim() || editableName.trim() === bot.name}
                        aria-label={`Save name for ${bot.name}`}
                      >
                        Save name
                      </Button>
                      <Select
                        label={`Role for ${bot.name}`}
                        value={bot.role || 'member'}
                        onChange={(value) => {
                          if (value && value !== bot.role) {
                            void handleUpdateBot(bot, { role: value as BotRole });
                          }
                        }}
                        data={[
                          { value: 'member', label: 'Member' },
                          { value: 'viewer', label: 'Viewer' },
                        ]}
                        allowDeselect={false}
                        style={{ flex: '1 1 140px' }}
                        disabled={busy}
                      />
                    </Group>
                  )}

                  <Stack gap={4}>
                    <Text size="xs" fw={600}>
                      Active tokens
                    </Text>
                    {bot.tokens.length ? (
                      bot.tokens.map((botToken) => (
                        <Group
                          key={botToken.id}
                          justify="space-between"
                          align="center"
                          wrap="wrap"
                          gap="xs"
                          data-testid={`bot-token-${botToken.id}`}
                        >
                          <Box style={{ minWidth: 0 }}>
                            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                              {botToken.name} · {botToken.prefix}...
                            </Text>
                            <Text size="xs" c="dimmed">
                              {lastUsedLabel(botToken.lastUsedAt)}
                            </Text>
                          </Box>
                          {!disabled && (
                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              onClick={() => setPending({ type: 'revoke', bot, token: botToken })}
                              disabled={busy}
                              aria-label={`Revoke token ${botToken.name} for ${bot.name}`}
                            >
                              Revoke token
                            </Button>
                          )}
                        </Group>
                      ))
                    ) : (
                      <Text size="xs" c="dimmed">
                        None
                      </Text>
                    )}
                  </Stack>

                  {!disabled && (
                    <Group align="flex-end" gap="xs" wrap="wrap">
                      <TextInput
                        label={`New token name for ${bot.name}`}
                        value={tokenNames[bot.id] ?? 'CLI token'}
                        onChange={(event) =>
                          setTokenNames((current) => ({
                            ...current,
                            [bot.id]: event.currentTarget.value,
                          }))
                        }
                        maxLength={60}
                        style={{ flex: '1 1 180px' }}
                        disabled={busy}
                      />
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => void handleIssueToken(bot)}
                        disabled={busy || !!visibleSecret}
                        aria-label={`Issue token for ${bot.name}`}
                      >
                        Issue token
                      </Button>
                    </Group>
                  )}
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </Stack>

      <ConfirmModal
        opened={!!pending}
        onClose={() => setPending(null)}
        onConfirm={confirmDestructiveAction}
        loading={busy}
        danger
        title={
          pending?.type === 'disable'
            ? `Disable ${pending.bot.name}?`
            : `Revoke ${pending?.token.name || 'token'}?`
        }
        confirmLabel={pending?.type === 'disable' ? 'Disable bot' : 'Revoke token'}
      >
        <Text size="sm">
          {pending?.type === 'disable'
            ? `${pending.bot.name} will lose access to ${workspace.name}. All its tokens will be revoked and it will no longer appear in the active member roster.`
            : `The token ${pending?.token.name} for ${pending?.bot.name} will stop working in ${workspace.name}. Other tokens for this bot will remain active.`}
        </Text>
      </ConfirmModal>
    </Paper>
  );
}
