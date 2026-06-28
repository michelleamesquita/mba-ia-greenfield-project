import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  HeadBucketCommand: jest.fn(),
  CreateBucketCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://minio/presigned-url'),
}));

describe('StorageService', () => {
  let service: StorageService;
  let s3SendMock: jest.Mock;

  const mockConfig = {
    endpoint: 'http://minio:9000',
    accessKey: 'access',
    secretKey: 'secret',
    bucketVideos: 'videos',
    region: 'us-east-1',
    presignedUploadExpiration: 3600,
    presignedStreamExpiration: 3600,
  };

  beforeEach(async () => {
    s3SendMock = jest.fn().mockResolvedValue({});

    (S3Client as jest.Mock).mockImplementation(() => ({
      send: s3SendMock,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: storageConfig.KEY,
          useValue: mockConfig,
        },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);

    // Mock onModuleInit to not connect to real MinIO
    jest.spyOn(service, 'onModuleInit').mockResolvedValue(undefined);
    await service.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateUploadPresignedUrl', () => {
    it('should return a presigned URL using PutObjectCommand', async () => {
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner') as {
        getSignedUrl: jest.Mock;
      };
      const url = await service.generateUploadPresignedUrl(
        'videos/channel-1/video-1.mp4',
        'video/mp4',
      );

      expect(url).toBe('https://minio/presigned-url');
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'videos',
        Key: 'videos/channel-1/video-1.mp4',
        ContentType: 'video/mp4',
      });
      expect(getSignedUrl).toHaveBeenCalled();
    });
  });

  describe('generateDownloadPresignedUrl', () => {
    it('should return a presigned URL using GetObjectCommand', async () => {
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner') as {
        getSignedUrl: jest.Mock;
      };
      const url = await service.generateDownloadPresignedUrl(
        'videos/channel-1/video-1.mp4',
      );

      expect(url).toBe('https://minio/presigned-url');
      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'videos',
        Key: 'videos/channel-1/video-1.mp4',
        ResponseContentDisposition: undefined,
      });
      expect(getSignedUrl).toHaveBeenCalled();
    });

    it('should pass ResponseContentDisposition when downloading', async () => {
      await service.generateDownloadPresignedUrl('videos/key.mp4', {
        responseContentDisposition: 'attachment; filename="video.mp4"',
      });

      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'videos',
        Key: 'videos/key.mp4',
        ResponseContentDisposition: 'attachment; filename="video.mp4"',
      });
    });
  });

  describe('deleteObject', () => {
    it('should send DeleteObjectCommand', async () => {
      await service.deleteObject('videos/channel-1/video-1.mp4');

      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'videos',
        Key: 'videos/channel-1/video-1.mp4',
      });
      expect(s3SendMock).toHaveBeenCalled();
    });
  });

  describe('objectExists', () => {
    it('should return true when HeadObjectCommand succeeds', async () => {
      s3SendMock.mockResolvedValue({});

      const exists = await service.objectExists('videos/key.mp4');

      expect(exists).toBe(true);
      expect(HeadObjectCommand).toHaveBeenCalledWith({
        Bucket: 'videos',
        Key: 'videos/key.mp4',
      });
    });

    it('should return false when HeadObjectCommand throws', async () => {
      s3SendMock.mockRejectedValue(new Error('NotFound'));

      const exists = await service.objectExists('videos/nonexistent.mp4');

      expect(exists).toBe(false);
    });
  });

  describe('getObjectUrl', () => {
    it('should return full URL for object key', () => {
      const url = service.getObjectUrl('videos/channel-1/video-1.mp4');
      expect(url).toBe('http://minio:9000/videos/videos/channel-1/video-1.mp4');
    });
  });
});
