import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

@Controller('uploads')
@UseGuards(AuthGuard('jwt'))
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadFile(@UploadedFile() file: { buffer: Buffer; mimetype: string; originalname: string; size: number }) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const isImage = ALLOWED_IMAGE_TYPES.includes(file.mimetype);
    const isFile = ALLOWED_FILE_TYPES.includes(file.mimetype);

    if (!isImage && !isFile) {
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}. Allowed: images (JPEG, PNG, GIF, WebP) and documents (PDF, DOC, DOCX, TXT)`,
      );
    }

    if (isImage) {
      return this.uploadsService.uploadImage(file);
    }

    return this.uploadsService.uploadFile(file);
  }
}
