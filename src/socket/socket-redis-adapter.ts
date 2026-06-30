import { createAdapter } from '@socket.io/redis-adapter';
import { RedisClientType } from 'redis';
import { Logger } from '@nestjs/common';

const logger = new Logger('SocketRedisAdapter');

export function createSocketRedisAdapter(pubClient: RedisClientType, subClient: RedisClientType) {
  logger.log('Initializing Socket.io Redis adapter for multi-node broadcast');
  return createAdapter(pubClient, subClient);
}
