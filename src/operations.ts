// Every operation of the public REST API (the `operationId`s of
// https://wuapi.dev/openapi.json) and every tool, or `tool.action`, that calls
// it. test/coverage.test.ts checks this table against the spec in the
// monorepo, both ways: no operation missing, no tool or action that does not
// exist.

export const OPERATION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  // context and usage
  getMe: ["get_current_key"],
  getUsage: ["get_usage"],
  getUsageByProject: ["get_usage_by_project"],
  getProjectUsage: ["get_usage_by_project"],

  // accounts
  listProxyLocations: ["list_proxy_locations"],
  listAccounts: ["list_accounts"],
  createAccount: ["create_account"],
  getAccount: ["get_account", "get_account_qr_code"],
  updateAccount: ["update_account"],
  deleteAccount: ["unlink_account.delete"],
  reconnectAccount: ["reconnect_account"],
  logoutAccount: ["unlink_account.logout"],
  createPairingCode: ["request_pairing_code"],
  setAccountPresence: ["set_presence.online", "set_presence.offline"],
  setDefaultDisappearingTimer: ["set_disappearing_timer"],
  rejectCall: ["reject_call"],

  // chats
  sendChatPresence: ["set_presence.typing", "set_presence.recording", "set_presence.paused"],
  sendReadReceipts: ["send_read_receipts"],
  markChatRead: ["mark_chat_read"],
  markChatUnread: ["mark_chat_read"],
  archiveChat: ["archive_chat"],
  unarchiveChat: ["archive_chat"],
  pinChat: ["pin_chat"],
  unpinChat: ["pin_chat"],
  muteChat: ["mute_chat"],
  unmuteChat: ["mute_chat"],
  deleteChat: ["delete_chat"],
  setChatDisappearingTimer: ["set_disappearing_timer"],

  // labels
  addChatLabel: ["manage_labels.label_chat"],
  removeChatLabel: ["manage_labels.unlabel_chat"],
  upsertLabel: ["manage_labels.upsert"],
  deleteLabel: ["manage_labels.delete"],
  addMessageLabel: ["manage_labels.label_message"],
  removeMessageLabel: ["manage_labels.unlabel_message"],

  // stories
  createStory: ["post_story"],

  // contacts
  checkContacts: ["check_numbers"],
  lookupContacts: ["lookup_contacts"],
  getContactPicture: ["lookup_whatsapp_info.contact_picture"],
  getBusinessProfile: ["lookup_whatsapp_info.business_profile"],
  subscribeContactPresence: ["set_presence.subscribe"],
  blockContact: ["manage_block_list.block"],
  unblockContact: ["manage_block_list.unblock"],
  listBlockedContacts: ["manage_block_list.list"],
  getContactLink: ["manage_profile.get_contact_link"],
  resetContactLink: ["manage_profile.reset_contact_link"],
  resolveLink: ["lookup_whatsapp_info.resolve_link"],
  listBots: ["lookup_whatsapp_info.bots"],
  getStickerPack: ["lookup_whatsapp_info.sticker_pack"],
  getOrder: ["lookup_whatsapp_info.order"],

  // profile and privacy
  updateProfile: ["manage_profile.update"],
  setProfilePicture: ["manage_profile.set_picture"],
  deleteProfilePicture: ["manage_profile.delete_picture"],
  getPrivacySettings: ["manage_privacy.get"],
  updatePrivacySettings: ["manage_privacy.update"],
  getStoryPrivacy: ["manage_privacy.get_story_privacy"],

  // messages
  sendMessage: ["send_text", "send_media", "send_location", "send_contact", "send_poll", "reply_to_message"],
  listMessages: ["list_messages"],
  getMessage: ["get_message", "reply_to_message", "cancel_message"],
  editMessage: ["edit_message"],
  deleteMessage: ["delete_message", "cancel_message"],
  reactToMessage: ["react_to_message"],
  voteInPoll: ["vote_in_poll"],
  starMessage: ["star_message"],
  unstarMessage: ["star_message"],

  // groups and communities
  listGroups: ["list_groups"],
  createGroup: ["create_group", "manage_community.create"],
  joinGroup: ["manage_group_joins.join"],
  getGroupInvite: ["manage_group_joins.preview_invite"],
  getGroup: ["get_group"],
  updateGroup: ["manage_group_settings.update"],
  leaveGroup: ["leave_group"],
  addGroupParticipants: ["add_group_participants"],
  removeGroupParticipants: ["remove_group_participants"],
  promoteGroupParticipants: ["promote_group_participants"],
  demoteGroupParticipants: ["demote_group_participants"],
  getGroupInviteLink: ["get_group_invite_link"],
  resetGroupInviteLink: ["reset_group_invite_link"],
  setGroupPicture: ["manage_group_settings.set_picture"],
  deleteGroupPicture: ["manage_group_settings.delete_picture"],
  listGroupJoinRequests: ["manage_group_joins.list_requests"],
  approveGroupJoinRequests: ["manage_group_joins.approve_requests"],
  rejectGroupJoinRequests: ["manage_group_joins.reject_requests"],
  listSubgroups: ["manage_community.list_groups"],
  linkSubgroup: ["manage_community.link_group"],
  unlinkSubgroup: ["manage_community.unlink_group"],
  listCommunityParticipants: ["manage_community.list_members"],

  // channels
  listChannels: ["manage_channel.list"],
  createChannel: ["manage_channel.create"],
  getChannelInvite: ["manage_channel.preview_invite"],
  getChannel: ["manage_channel.get"],
  followChannel: ["manage_channel.follow"],
  unfollowChannel: ["manage_channel.unfollow"],
  muteChannel: ["manage_channel.mute"],
  unmuteChannel: ["manage_channel.unmute"],
  listChannelMessages: ["manage_channel.list_messages"],
  reactToChannelMessage: ["manage_channel.react"],
  markChannelMessagesViewed: ["manage_channel.mark_viewed"],

  // webhooks
  listWebhookEndpoints: ["list_webhooks"],
  createWebhookEndpoint: ["create_webhook"],
  getWebhookEndpoint: ["get_webhook"],
  updateWebhookEndpoint: ["update_webhook"],
  deleteWebhookEndpoint: ["delete_webhook"],

  // projects
  createProject: ["create_project"],
  listProjects: ["list_projects"],
  getProject: ["get_project"],
  updateProject: ["manage_project.update"],
  deleteProject: ["manage_project.delete"],
  listProjectApiKeys: ["manage_project.list_keys"],
  revokeProjectApiKey: ["manage_project.revoke_key"],

  // invitations and branding
  createInvitation: ["create_invitation"],
  listInvitations: ["list_invitations"],
  getInvitation: ["get_invitation"],
  cancelInvitation: ["cancel_invitation"],
  resendInvitation: ["resend_invitation"],
  getBranding: ["manage_branding.get"],
  updateBranding: ["manage_branding.update"],
};

/**
 * Operations with no tool, on purpose. Both answer with a secret shown only
 * once; tool results never carry secrets (src/format.ts drops them), so a tool
 * would create a key or a signing secret nobody could read, and in the case of
 * the webhook secret break the receiving server's signature check at once.
 */
export const NOT_EXPOSED: Readonly<Record<string, string>> = {
  createProjectApiKey: "Returns the new API key once. Create project keys in the wuapi dashboard or with the SDK.",
  rotateWebhookEndpointSecret: "Returns the new signing secret once and the old one stops working. Rotate it in the wuapi dashboard.",
};
