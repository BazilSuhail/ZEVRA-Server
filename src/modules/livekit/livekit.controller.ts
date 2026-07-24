import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  UseGuards,
  Req,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { LivekitService } from './livekit.service';
import { LivekitWebhookService } from './livekit.webhook';
import { LivekitTokenDto } from './dto/livekit-token.dto';

@Controller('livekit')
export class LivekitController {
  constructor(
    private livekitService: LivekitService,
    private webhookService: LivekitWebhookService,
  ) {}

  // ─── Token Endpoint ──────────────────────────────────────────────────

  @Post('token')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async getToken(
    @Req() req: Request & { user: { id: string; username: string } },
    @Body() body: LivekitTokenDto,
  ) {
    const { roomName } = body;
    const { id: userId, username } = req.user;

    const authorized = await this.livekitService.authorizeRoomAccess(roomName, userId);
    if (!authorized) {
      throw new ForbiddenException('Not allowed to join this room');
    }

    const token = await this.livekitService.generateToken(roomName, userId, username);
    if (!token) {
      throw new ServiceUnavailableException('Calls are not available');
    }

    return {
      serverUrl: process.env.LIVEKIT_URL,
      token,
      roomName,
    };
  }

  // ─── Webhook Endpoint ────────────────────────────────────────────────
  // Signature verification needs the exact bytes LiveKit signed, so the raw
  // body (enabled in main.ts, incl. application/webhook+json) is used.

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Req() req: RawBodyRequest<Request>, @Headers('authorization') authHeader?: string) {
    const raw = req.rawBody;
    if (!raw || raw.length === 0 || !authHeader) {
      throw new UnauthorizedException('Invalid webhook');
    }

    const event = await this.livekitService.handleWebhook(raw.toString('utf8'), authHeader);
    if (!event) {
      throw new UnauthorizedException('Invalid webhook');
    }

    const roomName = event.room?.name;
    const identity = event.participant?.identity;

    switch (event.event) {
      case 'room_started':
        if (roomName) await this.webhookService.handleRoomStarted(roomName);
        break;
      case 'room_finished':
        if (roomName) await this.webhookService.handleRoomFinished(roomName);
        break;
      case 'participant_joined':
        if (roomName && identity) {
          await this.webhookService.handleParticipantJoined(roomName, identity, event.participant?.name || identity);
        }
        break;
      case 'participant_left':
        if (roomName && identity) await this.webhookService.handleParticipantLeft(roomName, identity);
        break;
      default:
        break;
    }

    return {};
  }
}
