import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  accessKey: process.env.STORAGE_ACCESS_KEY!,
  secretKey: process.env.STORAGE_SECRET_KEY!,
  bucketVideos: process.env.STORAGE_BUCKET_VIDEOS || 'videos',
  region: process.env.STORAGE_REGION || 'us-east-1',
  presignedUploadExpiration: parseInt(
    process.env.STORAGE_PRESIGNED_URL_EXPIRATION || '3600',
    10,
  ),
  presignedStreamExpiration: parseInt(
    process.env.STORAGE_STREAM_URL_EXPIRATION || '3600',
    10,
  ),
}));
