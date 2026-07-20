import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  Logger,
  UseGuards,
  Request,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
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
  @UseGuards(JwtAuthGuard)
  async getToken(
    @Request() req: { user: { id: string; username: string } },
    @Body() body: { roomName: string; participantName?: string },
  ) {
    const { roomName, participantName } = body;

    if (!roomName) {
      throw new BadRequestException('roomName is required');
    }

    // Never trust a client-supplied identity — always use the authenticated user
    const userId = req.user.id;
    const username = participantName || req.user.username;

    // Only allow joining rooms the authenticated user belongs to
    const authorized = await this.livekitService.authorizeRoomAccess(roomName, userId);
    if (!authorized) {
      throw new ForbiddenException('Not allowed to join this room');
    }

    const token = await this.livekitService.generateToken(roomName, userId, username);

    if (!token) {
      throw new UnauthorizedException('LiveKit not configured');
    }

    return {
      serverUrl: process.env.LIVEKIT_URL,
      token,
      roomName,
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
