import type { PendingMessage } from '../../redis/redis-session.service';

/** `message:new` payload (CONTRACT §4). Also the history item shape minus reactions. */
export type MessagePayload = PendingMessage;

export interface MessageReaction {
  emoji: string;
  userId: string;
  username: string | null;
}

export interface HistoryMessage extends MessagePayload {
  reactions: MessageReaction[];
}

export interface MessageRow {
  id: string;
  channelId: string;
  senderId: string;
  encryptedContent: string;
  contentIv: string;
  contentTag: string;
  signature: string;
  sequenceNumber: number;
  senderKeyEpoch: number;
  messageType: string;
  metadata: unknown;
  isDeleted: boolean;
  createdAt: Date | string;
}

export function toMessagePayload(row: MessageRow, senderUsername: string | null): MessagePayload {
  const deleted = !!row.isDeleted;
  return {
    id: row.id,
    messageId: row.id,
    channelId: row.channelId,
    senderId: row.senderId,
    senderUsername,
    encryptedContent: deleted ? '' : row.encryptedContent,
    contentIv: row.contentIv,
    contentTag: row.contentTag,
    signature: row.signature,
    sequenceNumber: row.sequenceNumber,
    senderKeyEpoch: row.senderKeyEpoch,
    messageType: row.messageType,
    metadata: deleted ? null : ((row.metadata as Record<string, unknown> | null) ?? null),
    isDeleted: deleted,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}
