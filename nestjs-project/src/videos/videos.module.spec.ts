import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { VideosService } from './videos.service';
import { VideosRepository } from './repositories/videos.repository';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { Video } from './entities/video.entity';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './videos.service';

describe('VideosModule', () => {
  it('should compile with all required providers', async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(queueConfig)],
      providers: [
        VideosService,
        VideosRepository,
        { provide: getRepositoryToken(Video), useValue: {} },
        {
          provide: StorageService,
          useValue: {
            generateUploadPresignedUrl: jest.fn(),
            generateDownloadPresignedUrl: jest.fn(),
            objectExists: jest.fn(),
            getObjectUrl: jest.fn(),
            onModuleInit: jest.fn(),
          },
        },
        {
          provide: ChannelsService,
          useValue: { findByUserId: jest.fn() },
        },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    expect(module.get(VideosService)).toBeDefined();
    expect(module.get(VideosRepository)).toBeDefined();
  });
});
