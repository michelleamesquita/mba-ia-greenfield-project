import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { ChannelsService } from '../channels/channels.service';
import {
  VideoInvalidStatusException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoOwnershipException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';
import { VideoStatus } from './enums/video-status.enum';
import { VideosRepository } from './repositories/videos.repository';
import { VideoProcessingJob } from './types/video-processing-job.type';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue<VideoProcessingJob>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<{ videoId: string; slug: string; uploadUrl: string }> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoOwnershipException();
    }

    const slug = nanoid(11);
    const extension = dto.filename.split('.').pop() ?? 'mp4';
    const storageKey = `videos/${channel.id}/${slug}.${extension}`;

    const video = await this.videosRepository.create({
      slug,
      storage_key: storageKey,
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      mime_type: dto.mimeType,
      size_bytes: String(dto.sizeBytes),
    });

    const uploadUrl = await this.storageService.generateUploadPresignedUrl(
      storageKey,
      dto.mimeType,
    );

    return { videoId: video.id, slug: video.slug, uploadUrl };
  }

  async completeUpload(videoId: string, userId: string): Promise<void> {
    const video = await this.getVideoOrFail(videoId);
    const channel = await this.channelsService.findByUserId(userId);

    if (!channel || video.channel_id !== channel.id) {
      throw new VideoOwnershipException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoInvalidStatusException(video.status);
    }

    const exists = video.storage_key
      ? await this.storageService.objectExists(video.storage_key)
      : false;

    if (!exists) {
      this.logger.warn(
        `completeUpload called but object not found in storage: ${video.storage_key}`,
      );
    }

    await this.videosRepository.updateStatus(video.id, VideoStatus.PENDING);

    const job: VideoProcessingJob = {
      videoId: video.id,
      storageKey: video.storage_key!,
      channelId: video.channel_id,
    };

    await this.videoQueue.add('process-video', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    this.logger.log(`Video ${video.id} queued for processing`);
  }

  async findBySlug(slug: string): Promise<Video> {
    const video = await this.videosRepository.findBySlug(slug);
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async getVideoResponse(slug: string): Promise<VideoResponseDto> {
    const video = await this.findBySlug(slug);
    return this.toResponseDto(video);
  }

  async getStreamUrl(slug: string): Promise<string> {
    const video = await this.findBySlug(slug);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    return this.storageService.generateDownloadPresignedUrl(video.storage_key!);
  }

  async getDownloadUrl(slug: string): Promise<string> {
    const video = await this.findBySlug(slug);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    return this.storageService.generateDownloadPresignedUrl(
      video.storage_key!,
      {
        responseContentDisposition: `attachment; filename="${video.slug}.mp4"`,
      },
    );
  }

  private async getVideoOrFail(id: string): Promise<Video> {
    const video = await this.videosRepository.findById(id);
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async toResponseDto(video: Video): Promise<VideoResponseDto> {
    let thumbnailUrl: string | null = null;

    if (video.thumbnail_key) {
      thumbnailUrl = await this.storageService.generateDownloadPresignedUrl(
        video.thumbnail_key,
      );
    }

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      duration: video.duration,
      thumbnailUrl,
      channelId: video.channel_id,
      createdAt: video.created_at,
    };
  }
}
