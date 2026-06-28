import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { VideoStatus } from '../enums/video-status.enum';
import type { VideoProcessingJob } from '../types/video-processing-job.type';

const VIDEO_PROCESSING_QUEUE = 'video-processing';

// Factory mocks prevent TypeORM (and path-scurry) from ever being loaded
jest.mock('../repositories/videos.repository', () => ({
  VideosRepository: jest.fn(),
}));
jest.mock('../../storage/storage.service', () => ({
  StorageService: jest.fn(),
}));
jest.mock('../videos.service', () => ({
  VIDEO_PROCESSING_QUEUE: 'video-processing',
}));

// Mock fluent-ffmpeg
jest.mock('fluent-ffmpeg', () => {
  const mockFfmpeg = jest.fn().mockReturnValue({
    on: jest.fn().mockImplementation(function (
      this: { on: jest.Mock; screenshots: jest.Mock },
      event: string,
      cb: () => void,
    ) {
      if (event === 'end') setTimeout(cb, 0);
      return this;
    }),
    screenshots: jest.fn().mockReturnThis(),
  });
  (mockFfmpeg as unknown as { ffprobe: jest.Mock }).ffprobe = jest
    .fn()
    .mockImplementation(
      (_file: string, callback: (err: null, data: object) => void) => {
        callback(null, {
          format: { duration: '120.5' },
          streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        });
      },
    );
  return mockFfmpeg;
});

// Mock fs
jest.mock('fs', () => ({
  createWriteStream: jest.fn().mockReturnValue({
    on: jest.fn().mockImplementation(function (
      this: { on: jest.Mock; close: jest.Mock },
      event: string,
      cb: () => void,
    ) {
      if (event === 'finish') setTimeout(cb, 0);
      return this;
    }),
    close: jest.fn(),
  }),
  existsSync: jest.fn().mockReturnValue(false),
  unlinkSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue(Buffer.from('fake-image')),
  unlink: jest.fn((_path: string, cb: () => void) => cb()),
}));

// Mock http – get is used to download video (needs pipe), request is used to upload thumbnail
const mockReqObject = {
  on: jest.fn().mockReturnThis(),
  write: jest.fn(),
  end: jest.fn(),
};

jest.mock('http', () => ({
  get: jest.fn(
    (
      _url: string,
      callback: (res: { pipe: jest.Mock; on: jest.Mock }) => void,
    ) => {
      const mockFile = { on: jest.fn(), close: jest.fn() };
      const mockStream = {
        on: jest.fn(),
        pipe: jest.fn((dest: { on: jest.Mock; close: jest.Mock }) => {
          const finishCb = dest.on.mock?.calls?.find(
            ([evt]: [string]) => evt === 'finish',
          );
          if (finishCb) setTimeout(finishCb[1], 0);
          void mockFile;
        }),
      };
      callback(mockStream);
      return { on: jest.fn() };
    },
  ),
  request: jest.fn(
    (
      _options: object,
      callback: (res: { statusCode: number; on: jest.Mock }) => void,
    ) => {
      callback({ statusCode: 200, on: jest.fn() });
      return mockReqObject;
    },
  ),
}));

import { VideoProcessingProcessor } from './video-processing.processor';
import { VideosRepository } from '../repositories/videos.repository';
import { StorageService } from '../../storage/storage.service';

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videosRepo: jest.Mocked<VideosRepository>;
  let storageService: jest.Mocked<StorageService>;

  const mockJob = (data: VideoProcessingJob): Job<VideoProcessingJob> =>
    ({
      id: 'job-1',
      data,
    }) as Job<VideoProcessingJob>;

  beforeEach(async () => {
    videosRepo = {
      updateStatus: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideosRepository>;

    storageService = {
      generateDownloadPresignedUrl: jest
        .fn()
        .mockResolvedValue('http://minio/video.mp4'),
      generateUploadPresignedUrl: jest
        .fn()
        .mockResolvedValue('http://minio/upload'),
      objectExists: jest.fn(),
      deleteObject: jest.fn(),
      getObjectUrl: jest.fn(),
      onModuleInit: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: VideosRepository, useValue: videosRepo },
        { provide: StorageService, useValue: storageService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: {} },
      ],
    }).compile();

    processor = module.get<VideoProcessingProcessor>(VideoProcessingProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  describe('process', () => {
    const jobData: VideoProcessingJob = {
      videoId: 'video-id-1',
      storageKey: 'videos/channel-1/video-id-1.mp4',
      channelId: 'channel-id-1',
    };

    it('should update status to PROCESSING at start', async () => {
      const job = mockJob(jobData);

      await processor.process(job).catch(() => undefined);

      expect(videosRepo.updateStatus).toHaveBeenCalledWith(
        'video-id-1',
        VideoStatus.PROCESSING,
      );
    });

    it('should update status to ERROR and set error_message on failure', async () => {
      const error = new Error('FFmpeg failed');

      const Ffmpeg = require('fluent-ffmpeg') as {
        ffprobe: jest.Mock;
      } & jest.Mock;
      Ffmpeg.ffprobe.mockImplementationOnce(
        (_: string, cb: (err: Error, data: null) => void) => cb(error, null),
      );

      const job = mockJob(jobData);

      await expect(processor.process(job)).rejects.toThrow('FFmpeg failed');

      expect(videosRepo.updateStatus).toHaveBeenCalledWith(
        'video-id-1',
        VideoStatus.ERROR,
        expect.objectContaining({ error_message: 'FFmpeg failed' }),
      );
    });
  });
});
