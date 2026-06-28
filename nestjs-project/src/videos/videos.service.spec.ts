import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import {
  VideoNotFoundException,
  VideoNotReadyException,
  VideoOwnershipException,
  VideoInvalidStatusException,
} from '../common/exceptions/domain.exception';
import { VideosService, VIDEO_PROCESSING_QUEUE } from './videos.service';
import { VideosRepository } from './repositories/videos.repository';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { VideoStatus } from './enums/video-status.enum';
import type { Video } from './entities/video.entity';
import type { Channel } from '../channels/entities/channel.entity';

const makeVideo = (overrides: Partial<Video> = {}): Video =>
  ({
    id: 'video-id-1',
    slug: 'abc12345678',
    title: null,
    storage_key: 'videos/channel-1/abc12345678.mp4',
    thumbnail_key: null,
    status: VideoStatus.DRAFT,
    duration: null,
    size_bytes: null,
    mime_type: 'video/mp4',
    error_message: null,
    channel_id: 'channel-id-1',
    created_at: new Date(),
    updated_at: new Date(),
    channel: {} as Channel,
    ...overrides,
  }) as Video;

describe('VideosService', () => {
  let service: VideosService;
  let videosRepo: jest.Mocked<VideosRepository>;
  let storageService: jest.Mocked<StorageService>;
  let channelsService: jest.Mocked<ChannelsService>;
  let videoQueue: { add: jest.Mock };

  beforeEach(async () => {
    videosRepo = {
      findById: jest.fn(),
      findBySlug: jest.fn(),
      findByChannelId: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<VideosRepository>;

    storageService = {
      generateUploadPresignedUrl: jest
        .fn()
        .mockResolvedValue('http://minio/upload-url'),
      generateDownloadPresignedUrl: jest
        .fn()
        .mockResolvedValue('http://minio/download-url'),
      deleteObject: jest.fn(),
      objectExists: jest.fn().mockResolvedValue(true),
      getObjectUrl: jest.fn(),
      onModuleInit: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;

    channelsService = {
      findByUserId: jest
        .fn()
        .mockResolvedValue({ id: 'channel-id-1' } as Channel),
      createChannel: jest.fn(),
    } as unknown as jest.Mocked<ChannelsService>;

    videoQueue = { add: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: VideosRepository, useValue: videosRepo },
        { provide: StorageService, useValue: storageService },
        { provide: ChannelsService, useValue: channelsService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: videoQueue,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('initiateUpload', () => {
    it('should create a draft video and return uploadUrl', async () => {
      const video = makeVideo();
      videosRepo.create.mockResolvedValue(video);

      const result = await service.initiateUpload('user-1', {
        filename: 'test.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      });

      expect(result.uploadUrl).toBe('http://minio/upload-url');
      expect(result.videoId).toBe('video-id-1');
      expect(result.slug).toBe('abc12345678');
      expect(videosRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.DRAFT,
          channel_id: 'channel-id-1',
          mime_type: 'video/mp4',
        }),
      );
    });

    it('should throw VideoOwnershipException when user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload('user-no-channel', {
          filename: 'test.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow(VideoOwnershipException);
    });
  });

  describe('completeUpload', () => {
    it('should change status to PENDING and enqueue job', async () => {
      const video = makeVideo();
      videosRepo.findById.mockResolvedValue(video);

      await service.completeUpload('video-id-1', 'user-1');

      expect(videosRepo.updateStatus).toHaveBeenCalledWith(
        'video-id-1',
        VideoStatus.PENDING,
      );
      expect(videoQueue.add).toHaveBeenCalledWith(
        'process-video',
        expect.objectContaining({
          videoId: 'video-id-1',
          storageKey: video.storage_key,
          channelId: 'channel-id-1',
        }),
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('should throw VideoNotFoundException when video does not exist', async () => {
      videosRepo.findById.mockResolvedValue(null);

      await expect(
        service.completeUpload('nonexistent', 'user-1'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw VideoOwnershipException when video belongs to different channel', async () => {
      const video = makeVideo({ channel_id: 'other-channel' });
      videosRepo.findById.mockResolvedValue(video);

      await expect(
        service.completeUpload('video-id-1', 'user-1'),
      ).rejects.toThrow(VideoOwnershipException);
    });

    it('should throw VideoInvalidStatusException when video is not in DRAFT', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      videosRepo.findById.mockResolvedValue(video);

      await expect(
        service.completeUpload('video-id-1', 'user-1'),
      ).rejects.toThrow(VideoInvalidStatusException);
    });
  });

  describe('getStreamUrl', () => {
    it('should return presigned URL for READY video', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      videosRepo.findBySlug.mockResolvedValue(video);

      const url = await service.getStreamUrl('abc12345678');

      expect(url).toBe('http://minio/download-url');
      expect(storageService.generateDownloadPresignedUrl).toHaveBeenCalledWith(
        video.storage_key,
      );
    });

    it('should throw VideoNotReadyException when video is not READY', async () => {
      const video = makeVideo({ status: VideoStatus.PROCESSING });
      videosRepo.findBySlug.mockResolvedValue(video);

      await expect(service.getStreamUrl('abc12345678')).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('should throw VideoNotFoundException for unknown slug', async () => {
      videosRepo.findBySlug.mockResolvedValue(null);

      await expect(service.getStreamUrl('nonexistent')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('should return presigned URL with attachment disposition', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      videosRepo.findBySlug.mockResolvedValue(video);

      const url = await service.getDownloadUrl('abc12345678');

      expect(url).toBe('http://minio/download-url');
      expect(storageService.generateDownloadPresignedUrl).toHaveBeenCalledWith(
        video.storage_key,
        expect.objectContaining({
          responseContentDisposition: expect.stringContaining('attachment'),
        }),
      );
    });
  });

  describe('getVideoResponse', () => {
    it('should return VideoResponseDto without thumbnailUrl when no thumbnail_key', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        thumbnail_key: null,
      });
      videosRepo.findBySlug.mockResolvedValue(video);

      const dto = await service.getVideoResponse('abc12345678');

      expect(dto.thumbnailUrl).toBeNull();
      expect(dto.slug).toBe('abc12345678');
      expect(dto.status).toBe(VideoStatus.READY);
    });

    it('should return thumbnailUrl when thumbnail_key is set', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        thumbnail_key: 'thumbnails/channel-1/video-id-1.jpg',
      });
      videosRepo.findBySlug.mockResolvedValue(video);

      const dto = await service.getVideoResponse('abc12345678');

      expect(dto.thumbnailUrl).toBe('http://minio/download-url');
    });
  });
});
