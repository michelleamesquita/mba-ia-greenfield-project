import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import Ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../enums/video-status.enum';
import { VideosRepository } from '../repositories/videos.repository';
import { VideoProcessingJob } from '../types/video-processing-job.type';

@Processor('video-processing', {
  concurrency: 2,
})
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJob>): Promise<void> {
    const { videoId, storageKey, channelId } = job.data;
    this.logger.log(`Processing video ${videoId} (job ${job.id})`);

    await this.videosRepository.updateStatus(videoId, VideoStatus.PROCESSING);

    const ext = storageKey.split('.').pop() ?? 'mp4';
    const tempVideoPath = path.join(os.tmpdir(), `video-${videoId}.${ext}`);
    const tempThumbPath = path.join(os.tmpdir(), `thumb-${videoId}.jpg`);

    try {
      // 1. Download video from MinIO to temp file
      const downloadUrl =
        await this.storageService.generateDownloadPresignedUrl(storageKey);
      await this.downloadFile(downloadUrl, tempVideoPath);

      // 2. Extract metadata via ffprobe
      const metadata = await this.probeVideo(tempVideoPath);
      const durationSeconds = Math.round(metadata.duration ?? 0);

      // 3. Generate thumbnail at 1-second mark
      await this.generateThumbnail(tempVideoPath, tempThumbPath);

      // 4. Upload thumbnail to MinIO
      const thumbnailKey = `thumbnails/${channelId}/${videoId}.jpg`;
      const thumbBuffer = fs.readFileSync(tempThumbPath);
      await this.uploadThumbnail(thumbnailKey, thumbBuffer);

      // 5. Update video record to READY
      await this.videosRepository.updateStatus(videoId, VideoStatus.READY, {
        duration: durationSeconds,
        thumbnail_key: thumbnailKey,
      });

      this.logger.log(`Video ${videoId} processed successfully`);
    } catch (err) {
      this.logger.error(`Error processing video ${videoId}`, err);
      await this.videosRepository.updateStatus(videoId, VideoStatus.ERROR, {
        error_message:
          err instanceof Error ? err.message : 'Unknown processing error',
      });
      throw err;
    } finally {
      this.cleanup(tempVideoPath, tempThumbPath);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<VideoProcessingJob>, err: Error): void {
    this.logger.error(
      `Job ${job.id} for video ${job.data.videoId} failed: ${err.message}`,
    );
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const protocol = url.startsWith('https') ? https : http;

      protocol
        .get(url, (response) => {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', (err) => {
          fs.unlink(destPath, () => undefined);
          reject(err);
        });
    });
  }

  private probeVideo(
    filePath: string,
  ): Promise<{ duration: number; width?: number; height?: number }> {
    return new Promise((resolve, reject) => {
      Ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err)
          return reject(err instanceof Error ? err : new Error(String(err)));

        const stream = metadata.streams.find((s) => s.codec_type === 'video');
        const format = metadata.format;

        resolve({
          duration: Number(format.duration ?? 0),
          width: stream?.width,
          height: stream?.height,
        });
      });
    });
  }

  private generateThumbnail(
    videoPath: string,
    thumbPath: string,
  ): Promise<void> {
    const thumbDir = path.dirname(thumbPath);
    const thumbFilename = path.basename(thumbPath);

    return new Promise((resolve, reject) => {
      Ffmpeg(videoPath)
        .on('end', () => resolve())
        .on('error', reject)
        .screenshots({
          timestamps: [1],
          filename: thumbFilename,
          folder: thumbDir,
          size: '1280x720',
        });
    });
  }

  private async uploadThumbnail(key: string, buffer: Buffer): Promise<void> {
    const uploadUrl = await this.storageService.generateUploadPresignedUrl(
      key,
      'image/jpeg',
    );

    await new Promise<void>((resolve, reject) => {
      const urlObj = new URL(uploadUrl);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': buffer.length,
        },
      };

      const protocol = urlObj.protocol === 'https:' ? https : http;
      const req = protocol.request(options, (res) => {
        if (res.statusCode && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.write(buffer);
      req.end();
    });
  }

  private cleanup(...paths: string[]): void {
    for (const p of paths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        this.logger.warn(`Failed to clean up temp file: ${p}`);
      }
    }
  }
}
