export enum MessageType {
  TEXT = 'text',
  IMAGE = 'image',
  FILE = 'file',
  AUDIO = 'audio',
  VIDEO = 'video',
  SYSTEM = 'system',
}

export enum ChannelType {
  DIRECT = 'direct',
  GROUP = 'group',
}

export enum UserStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  AWAY = 'away',
  DND = 'dnd',
}

export enum EventType {
  MESSAGE_SENT = 'message_sent',
  MESSAGE_DELETED = 'message_deleted',
  USER_JOINED = 'user_joined',
  USER_LEFT = 'user_left',
}

export enum Role {
  MEMBER = 'member',
  ADMIN = 'admin',
  OWNER = 'owner',
}