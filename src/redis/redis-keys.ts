/**
 * Central Redis key naming (CONTRACT §6): every key is `zevra:{domain}:{id}[:{subid}]`
 * and every key written by the server carries a TTL.
 */
export const RedisKeys = {
  /** Sorted set of live socket ids for a user (score = last heartbeat ms). */
  sockets: (userId: string) => `zevra:sockets:${userId}`,
  presence: (userId: string) => `zevra:presence:${userId}`,
  channelMembers: (channelId: string) => `zevra:channel:members:${channelId}`,
  messageCache: (channelId: string) => `zevra:cache:messages:${channelId}`,
  unread: (userId: string, channelId: string) => `zevra:unread:${userId}:${channelId}`,
  /** Sorted set of typing user ids for a channel (score = expiry ms). */
  typing: (channelId: string) => `zevra:typing:${channelId}`,
  pending: (userId: string) => `zevra:pending:${userId}`,
  rateLimit: (scope: string, key: string) => `zevra:ratelimit:${scope}:${key}`,
} as const;

export const RedisTtl = {
  /** Socket registry: refreshed by every heartbeat (30s). */
  socketsSeconds: 120,
  /** A socket entry older than this is considered dead (missed 3 heartbeats). */
  socketStaleMs: 95_000,
  presenceSeconds: 90,
  channelMembersSeconds: 3600,
  messageCacheSeconds: 86_400,
  unreadSeconds: 30 * 86_400,
  typingSeconds: 10,
  typingEntryMs: 6_000,
  pendingSeconds: 7 * 86_400,
} as const;

export const MESSAGE_CACHE_SIZE = 50;
