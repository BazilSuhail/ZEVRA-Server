import { Injectable, Logger } from '@nestjs/common';
import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';

const API_KEY = process.env.LIVEKIT_API_KEY!;
const API_SECRET = process.env.LIVEKIT_API_SECRET!;
const LIVEKIT_URL = process.env.LIVEKIT_URL!;

@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);
  private roomClient: RoomServiceClient | null = null;
  private webhookReceiver: WebhookReceiver | null = null;

  constructor() {
    if (API_KEY && API_SECRET && LIVEKIT_URL) {
      this.roomClient = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
      this.webhookReceiver = new WebhookReceiver(API_KEY, API_SECRET);
      this.logger.log('LiveKit service initialized');
    } else {
      this.logger.warn('LiveKit credentials not set — LiveKit features disabled');
    }
  }

  get isConfigured(): boolean {
    return this.roomClient !== null;
  }

  // ─── Token Generation ────────────────────────────────────────────────

  async generateToken(
    roomName: string,
    userId: string,
    username: string,
  ): Promise<string | null> {
    if (!this.isConfigured) return null;

    const at = new AccessToken(API_KEY, API_SECRET, {
      identity: userId,
      name: username,
      ttl: '10m',
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return await at.toJwt();
  }

  // ─── Room Management ────────────────────────────────────────────────

  async createRoom(roomName: string, maxParticipants: number): Promise<void> {
    if (!this.roomClient) return;

    try {
      await this.roomClient.createRoom({
        name: roomName,
        emptyTimeout: 60, // Auto-delete 60s after empty
        maxParticipants,
      });
      this.logger.log(`LiveKit room created: ${roomName} (max: ${maxParticipants})`);
    } catch (err) {
      this.logger.error(`Failed to create LiveKit room: ${(err as Error).message}`);
    }
  }

  async deleteRoom(roomName: string): Promise<void> {
    if (!this.roomClient) return;

    try {
      await this.roomClient.deleteRoom(roomName);
      this.logger.log(`LiveKit room deleted: ${roomName}`);
    } catch (err) {
      this.logger.error(`Failed to delete LiveKit room: ${(err as Error).message}`);
    }
  }

  async getParticipants(roomName: string) {
    if (!this.roomClient) return [];

    try {
      return await this.roomClient.listParticipants(roomName);
    } catch {
      return [];
    }
  }

  // ─── Webhook ─────────────────────────────────────────────────────────

  async handleWebhook(body: string, authHeader: string) {
    if (!this.webhookReceiver) return null;

    try {
      return await this.webhookReceiver.receive(body, authHeader);
    } catch (err) {
      this.logger.error(`Webhook verification failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Room Name Helpers ──────────────────────────────────────────────

  static getDmRoomName(userId1: string, userId2: string): string {
    const sorted = [userId1, userId2].sort();
    return `dm-${sorted[0]}-${sorted[1]}`;
  }

  static getGroupRoomName(): string {
    return `group-${crypto.randomUUID()}`;
  }
}
