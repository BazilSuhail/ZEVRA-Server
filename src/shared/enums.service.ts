import { Injectable } from '@nestjs/common';
import { MessageType, ChannelType, UserStatus, EventType, Role } from './enums';

@Injectable()
export class EnumsService {
  getMessageTypes(): MessageType[] {
    return Object.values(MessageType);
  }

  getChannelTypes(): ChannelType[] {
    return Object.values(ChannelType);
  }

  getUserStatuses(): UserStatus[] {
    return Object.values(UserStatus);
  }

  getEventTypes(): EventType[] {
    return Object.values(EventType);
  }

  getRoles(): Role[] {
    return Object.values(Role);
  }
}