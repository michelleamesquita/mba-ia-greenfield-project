import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.service';
import { VideoStatus } from '../src/videos/enums/video-status.enum';
import { VideosRepository } from '../src/videos/repositories/videos.repository';
import { StorageService } from '../src/storage/storage.service';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videosRepository: VideosRepository;

  // Mock storage and queue — these don't connect to real MinIO/Redis in E2E
  const mockStorageService = {
    onModuleInit: jest.fn().mockResolvedValue(undefined),
    generateUploadPresignedUrl: jest
      .fn()
      .mockResolvedValue('http://minio:9000/videos/presigned-upload'),
    generateDownloadPresignedUrl: jest
      .fn()
      .mockResolvedValue('http://minio:9000/videos/presigned-download'),
    objectExists: jest.fn().mockResolvedValue(true),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    getObjectUrl: jest.fn().mockReturnValue('http://minio:9000/videos/key'),
  };

  const mockVideoQueue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue(mockStorageService)
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue(mockVideoQueue)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    videosRepository = moduleFixture.get(VideosRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    jest.clearAllMocks();
    mockStorageService.generateUploadPresignedUrl.mockResolvedValue(
      'http://minio:9000/videos/presigned-upload',
    );
    mockStorageService.generateDownloadPresignedUrl.mockResolvedValue(
      'http://minio:9000/videos/presigned-download',
    );
    mockStorageService.objectExists.mockResolvedValue(true);
  });

  async function registerAndLogin(): Promise<{
    accessToken: string;
    channelId: string;
  }> {
    const email = `user-${Date.now()}@test.com`;
    const password = 'password123';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    // Confirm email (get token from DB)
    const tokenRecord = await dataSource.query<{ token: string }[]>(
      `SELECT token FROM verification_tokens WHERE type='email_confirmation' ORDER BY created_at DESC LIMIT 1`,
    );
    const token = tokenRecord[0]?.token;
    if (token) {
      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(200);
    }

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const accessToken = (loginRes.body as { access_token: string })
      .access_token;
    const channelRes = await dataSource.query<{ id: string }[]>(
      `SELECT channels.id FROM channels 
       JOIN users ON channels.user_id = users.id 
       WHERE users.email = $1`,
      [email],
    );
    const channelId = channelRes[0]?.id ?? '';

    return { accessToken, channelId };
  }

  describe('POST /videos/upload', () => {
    it('should return 401 without authentication', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload')
        .send({ filename: 'test.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(401);
    });

    it('should return 201 with videoId, slug, and uploadUrl', async () => {
      const { accessToken } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'test.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(201);

      const body = res.body as {
        videoId: string;
        slug: string;
        uploadUrl: string;
      };
      expect(body.videoId).toBeDefined();
      expect(body.slug).toHaveLength(11);
      expect(body.uploadUrl).toContain('minio');
    });

    it('should return 400 for missing required fields', async () => {
      const { accessToken } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'test.mp4' })
        .expect(400);

      expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:id/complete', () => {
    it('should return 204 and enqueue processing job', async () => {
      const { accessToken } = await registerAndLogin();

      const uploadRes = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'test.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(201);

      const { videoId } = uploadRes.body as { videoId: string };

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      expect(mockVideoQueue.add).toHaveBeenCalledWith(
        'process-video',
        expect.objectContaining({ videoId }),
        expect.any(Object),
      );

      const video = await videosRepository.findById(videoId);
      expect(video?.status).toBe(VideoStatus.PENDING);
    });

    it('should return 401 without authentication', async () => {
      await request(app.getHttpServer())
        .post('/videos/nonexistent/complete')
        .expect(401);
    });

    it('should return 404 for nonexistent video', async () => {
      const { accessToken } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });

    it('should return 403 when video belongs to another user', async () => {
      const { accessToken } = await registerAndLogin();
      const { accessToken: otherToken } = await registerAndLogin();

      const uploadRes = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'test.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(201);

      const { videoId } = uploadRes.body as { videoId: string };

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);

      expect((res.body as { error: string }).error).toBe(
        'VIDEO_OWNERSHIP_DENIED',
      );
    });
  });

  describe('GET /videos/:slug', () => {
    it('should return video metadata without authentication', async () => {
      const { accessToken } = await registerAndLogin();

      const uploadRes = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'test.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(201);

      const { slug } = uploadRes.body as { slug: string };

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .expect(200);

      const body = res.body as {
        slug: string;
        status: string;
        id: string;
      };
      expect(body.slug).toBe(slug);
      expect(body.status).toBe(VideoStatus.DRAFT);
    });

    it('should return 404 for nonexistent slug', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/nonexistent-slug')
        .expect(404);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:slug/stream', () => {
    it('should return 409 when video is not ready', async () => {
      const { accessToken } = await registerAndLogin();

      const uploadRes = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'test.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(201);

      const { slug } = uploadRes.body as { slug: string };

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .expect(409);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
    });

    it('should return 302 redirect when video is ready', async () => {
      const { accessToken } = await registerAndLogin();

      const uploadRes = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'test.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(201);

      const { slug, videoId } = uploadRes.body as {
        slug: string;
        videoId: string;
      };

      // Manually set video to READY for this test
      await videosRepository.updateStatus(videoId, VideoStatus.READY, {
        storage_key: 'videos/channel-1/abc12345678.mp4',
      });

      await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .expect(302);
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('should return 409 when video is not ready', async () => {
      const { accessToken } = await registerAndLogin();

      const uploadRes = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'test.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(201);

      const { slug } = uploadRes.body as { slug: string };

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .expect(409);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
    });
  });
});
