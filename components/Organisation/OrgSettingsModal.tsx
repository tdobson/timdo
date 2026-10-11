'use client';

import React, { useState } from 'react';
import {
  IconBuilding,
  IconClock,
  IconCrown,
  IconTrash,
  IconUser,
  IconUserCheck,
} from '@tabler/icons-react';
import {
  ActionIcon,
  Badge,
  Box,
  Card,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import {
  useInviteMember,
  useOrganisation,
  useOrganisationInvites,
  useOrganisationMembers,
  useRemoveMember,
  useUpdateMemberRole,
} from '../../app/hooks/useOrganisationQueries';
import type { AutocompleteUserResult } from '../../app/types/organisation.types';
import { BotMarker } from '../Team/BotMarker';
import { InviteMemberForm } from './InviteMemberForm';
import { MemberAutocomplete } from './MemberAutocomplete';

export interface OrgSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  orgId: string;
  currentUserId?: string;
}

export function OrgSettingsModal({ opened, onClose, orgId, currentUserId }: OrgSettingsModalProps) {
  const [selectedInviteEmail, setSelectedInviteEmail] = useState('');
  const [activeTab, setActiveTab] = useState<string | null>('members');

  const { data: org, isLoading: orgLoading } = useOrganisation(orgId);
  const { data: members = [], isLoading: membersLoading } = useOrganisationMembers(orgId);
  const { data: invites = [], isLoading: invitesLoading } = useOrganisationInvites(orgId);

  const inviteMutation = useInviteMember(orgId);
  const updateRoleMutation = useUpdateMemberRole(orgId);
  const removeMemberMutation = useRemoveMember(orgId);

  const currentUserMembership = members.find((m) => m.userId === currentUserId);
  const isOwnerOrAdmin =
    currentUserMembership?.role === 'owner' || currentUserMembership?.role === 'admin';

  const handleInviteSubmit = async (email: string, role: 'admin' | 'member') => {
    await inviteMutation.mutateAsync({ email, role });
    setSelectedInviteEmail('');
  };

  const handleSelectExistingUser = async (user: AutocompleteUserResult) => {
    await inviteMutation.mutateAsync({ email: user.email, role: 'member' });
  };

  const handleRoleChange = async (userId: string, newRole: string | null) => {
    if (!newRole) {
      return;
    }
    await updateRoleMutation.mutateAsync({
      userId,
      role: newRole as 'admin' | 'member',
    });
  };

  const handleRemoveMember = async (userId: string) => {
    await removeMemberMutation.mutateAsync(userId);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <IconBuilding size={20} />
          <Title order={4}>Organisation Settings: {org?.name || 'Loading...'}</Title>
        </Group>
      }
      size="lg"
    >
      {orgLoading ? (
        <Group justify="center" p="xl">
          <Loader size="md" />
        </Group>
      ) : (
        <Stack gap="md">
          {/* Add / Invite Team Member section */}
          {isOwnerOrAdmin && (
            <Card withBorder p="sm" radius="md">
              <Title order={5} mb="xs">
                Add or Invite Team Member
              </Title>
              <Stack gap="sm">
                <MemberAutocomplete
                  orgId={orgId}
                  onSelectExistingUser={handleSelectExistingUser}
                  onSelectInviteEmail={(email) => setSelectedInviteEmail(email)}
                />
                <InviteMemberForm
                  initialEmail={selectedInviteEmail}
                  onInvite={handleInviteSubmit}
                  isLoading={inviteMutation.isPending}
                />
              </Stack>
            </Card>
          )}

          {/* Members & Invites Tabs */}
          <Tabs value={activeTab} onChange={setActiveTab}>
            <Tabs.List>
              <Tabs.Tab
                value="members"
                leftSection={<IconUserCheck size={16} />}
                rightSection={<Badge size="xs">{members.length}</Badge>}
              >
                Members
              </Tabs.Tab>
              <Tabs.Tab
                value="invites"
                leftSection={<IconClock size={16} />}
                rightSection={<Badge size="xs">{invites.length}</Badge>}
              >
                Pending Invites
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="members" pt="sm">
              {membersLoading ? (
                <Group justify="center" p="md">
                  <Loader size="sm" />
                </Group>
              ) : (
                <Table striped highlightOnHover verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name / Email</Table.Th>
                      <Table.Th>Role</Table.Th>
                      {isOwnerOrAdmin && (
                        <Table.Th style={{ textAlign: 'right' }}>Actions</Table.Th>
                      )}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {members.map((member) => {
                      const isSelf = member.userId === currentUserId;
                      const isTargetOwner = member.role === 'owner';
                      const isBot = member.kind === 'bot' || member.userId.startsWith('bot|');

                      return (
                        <Table.Tr key={member.id} data-testid={`member-row-${member.userId}`}>
                          <Table.Td>
                            <Group gap="xs">
                              <IconUser size={16} />
                              <Box>
                                <Group gap="xs">
                                  <Text size="sm" fw={500}>
                                    {member.userName || (isBot ? 'Bot' : 'Unnamed User')}
                                  </Text>
                                  <BotMarker kind={isBot ? 'bot' : member.kind} />
                                  {isSelf && (
                                    <Badge size="xs" color="blue" variant="outline">
                                      You
                                    </Badge>
                                  )}
                                </Group>
                                {!isBot && member.userEmail && (
                                  <Text size="xs" c="dimmed">
                                    {member.userEmail}
                                  </Text>
                                )}
                              </Box>
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            {isTargetOwner ? (
                              <Badge leftSection={<IconCrown size={12} />} color="yellow">
                                Owner
                              </Badge>
                            ) : isOwnerOrAdmin && !isSelf && !isBot ? (
                              <Select
                                size="xs"
                                value={member.role}
                                onChange={(val) => handleRoleChange(member.userId, val)}
                                data={[
                                  { value: 'member', label: 'Member' },
                                  { value: 'admin', label: 'Admin' },
                                ]}
                                style={{ width: 110 }}
                                data-testid={`role-select-${member.userId}`}
                              />
                            ) : (
                              <Badge
                                color={member.role === 'admin' ? 'blue' : 'gray'}
                                variant="light"
                              >
                                {member.role}
                              </Badge>
                            )}
                          </Table.Td>
                          {isOwnerOrAdmin && (
                            <Table.Td style={{ textAlign: 'right' }}>
                              {!isSelf && !isTargetOwner && !isBot && (
                                <ActionIcon
                                  color="red"
                                  variant="subtle"
                                  onClick={() => handleRemoveMember(member.userId)}
                                  data-testid={`remove-member-${member.userId}`}
                                  title="Remove Member"
                                >
                                  <IconTrash size={16} />
                                </ActionIcon>
                              )}
                            </Table.Td>
                          )}
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              )}
            </Tabs.Panel>

            <Tabs.Panel value="invites" pt="sm">
              {invitesLoading ? (
                <Group justify="center" p="md">
                  <Loader size="sm" />
                </Group>
              ) : invites.length === 0 ? (
                <Text size="sm" c="dimmed" ta="center" py="md">
                  No pending invitations
                </Text>
              ) : (
                <Table striped highlightOnHover verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Invited Email</Table.Th>
                      <Table.Th>Role</Table.Th>
                      <Table.Th>Status</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {invites.map((invite) => (
                      <Table.Tr key={invite.id} data-testid={`invite-row-${invite.id}`}>
                        <Table.Td>
                          <Text size="sm">{invite.email}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge size="xs" color="gray">
                            {invite.role}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Badge size="xs" color="orange" variant="light">
                            Pending Invite
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}
    </Modal>
  );
}
