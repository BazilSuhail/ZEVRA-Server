import { Injectable, OnModuleInit, Logger, ServiceUnavailableException } from '@nestjs/common';
import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

interface UploadInput {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface UploadResult {
  url: string;
  publicId: string;
  format: string;
  resourceType: string;
  bytes: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
}

const DEFAULT_FOLDER = 'zevra/uploads';

@Injectable()
export class UploadsService implements OnModuleInit {
  private readonly logger = new Logger(UploadsService.name);
  private configured = false;

  onModuleInit() {
    const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      this.logger.warn('Cloudinary credentials not set — uploads disabled');
      return;
    }
    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key: CLOUDINARY_API_KEY,
      api_secret: CLOUDINARY_API_SECRET,
      secure: true,
    });
    this.configured = true;
  }

  private upload(file: UploadInput, options: UploadApiOptions): Promise<UploadApiResponse> {
    if (!this.configured) {
      return Promise.reject(new ServiceUnavailableException('File uploads are not available'));
    }
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
        if (error || !result) {
          this.logger.error(`Cloudinary upload failed: ${error?.message ?? 'empty response'}`);
          return reject(new ServiceUnavailableException('Upload failed, please try again'));
        }
        resolve(result);
      });
      Readable.from(file.buffer).pipe(uploadStream);
    });
  }

  async uploadImage(file: UploadInput, folder: string = DEFAULT_FOLDER): Promise<UploadResult> {
    const result = await this.upload(file, {
      folder,
      resource_type: 'image',
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    });
    const thumbnailUrl = cloudinary.url(result.public_id, {
      secure: true,
      transformation: [{ width: 200, height: 200, crop: 'thumb', gravity: 'face' }],
    });
    return {
      url: result.secure_url,
      publicId: result.public_id,
      format: result.format,
      resourceType: result.resource_type,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      thumbnailUrl,
    };
  }

  async uploadFile(file: UploadInput, folder: string = DEFAULT_FOLDER): Promise<UploadResult> {
    const result = await this.upload(file, { folder, resource_type: 'raw' });
    return {
      url: result.secure_url,
      publicId: result.public_id,
      format: result.format,
      resourceType: result.resource_type,
      bytes: result.bytes,
    };
  }
}
