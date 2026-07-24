import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { UploadsService } from './uploads.service';
import { detectAllowedMime, IMAGE_MIMES } from './file-type';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface IncomingFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

@Controller('uploads')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post()
  @RateLimit({ scope: 'upload', limit: 20, windowMs: 60_000, byUser: true })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
    }),
  )
  async uploadFile(@UploadedFile() file: IncomingFile | undefined) {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException('No file provided');
    }

    const mime = detectAllowedMime(file.buffer, file.mimetype);
    if (!mime) {
      throw new BadRequestException(
        'Unsupported file type. Allowed: images (JPEG, PNG, GIF, WebP) and documents (PDF, DOC, DOCX, TXT)',
      );
    }

    const verified = { ...file, mimetype: mime };
    return IMAGE_MIMES.has(mime)
      ? this.uploadsService.uploadImage(verified)
      : this.uploadsService.uploadFile(verified);
  }
}
