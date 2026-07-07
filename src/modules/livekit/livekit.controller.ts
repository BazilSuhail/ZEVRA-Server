import { Controller, Post, Body, Headers, HttpCode, Logger } from '@nestjs/common';
import { LivekitService } from './livekit.service';
import { LivekitWebhookService } from './livekit.webhook';

@Controller('livekit')
export class LivekitController {
  private readonly logger = new Logger(LivekitController.name);

  constructor(
    private livekitService: LivekitService,
    private webhookService: LivekitWebhookService,
  ) {}

  // ─── Token Endpoint ──────────────────────────────────────────────────

  @Post('token')
  async getToken(
    @Body() body: { roomName: string; participantIdentity: string; participantName: string },
  ) {
    const { roomName, participantIdentity, participantName } = body;

    if (!roomName || !participantIdentity || !participantName) {
      return { error: 'roomName, participantIdentity, and participantName are required' };
    }

    const token = await this.livekitService.generateToken(
      roomName,
      participantIdentity,
      participantName,
    );

    if (!token) {
      return { error: 'LiveKit not configured' };
    }

    return {
      serverUrl: process.env.LIVEKIT_URL,
      token,
    };
  }

  // ─── Webhook Endpoint ────────────────────────────────────────────────

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Body() body: string,
    @Headers('authorization') authHeader: string,
  ) {
    const event = await this.livekitService.handleWebhook(body, authHeader);

    if (!event) {
      this.logger.warn('Invalid webhook event');
      return {};
    }

    switch (event.event) {
      case 'room_started': {
        const roomName = event.room?.name;
        if (roomName) {
          await this.webhookService.handleRoomStarted(roomName);
        }
        break;
      }

      case 'room_finished': {
        const roomName = event.room?.name;
        if (roomName) {
          await this.webhookService.handleRoomFinished(roomName, 0);
        }
        break;
      }

      case 'participant_joined': {
        const roomName = event.room?.name;
        const identity = event.participant?.identity;
        const name = event.participant?.name;
        if (roomName && identity) {
          await this.webhookService.handleParticipantJoined(roomName, identity, name || identity);
        }
        break;
      }

      case 'participant_left': {
        const roomName = event.room?.name;
        const identity = event.participant?.identity;
        if (roomName && identity) {
          await this.webhookService.handleParticipantLeft(roomName, identity);
        }
        break;
      }
    }

    return {};
  }
}
