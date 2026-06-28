import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../enums/video-status.enum';

@Injectable()
export class VideosRepository {
  constructor(
    @InjectRepository(Video)
    private readonly repo: Repository<Video>,
  ) {}

  findById(id: string): Promise<Video | null> {
    return this.repo.findOne({ where: { id } });
  }

  findBySlug(slug: string): Promise<Video | null> {
    return this.repo.findOne({ where: { slug } });
  }

  findByChannelId(channelId: string): Promise<Video[]> {
    return this.repo.find({
      where: { channel_id: channelId },
      order: { created_at: 'DESC' },
    });
  }

  create(data: Partial<Video>): Promise<Video> {
    const video = this.repo.create(data);
    return this.repo.save(video);
  }

  async updateStatus(
    id: string,
    status: VideoStatus,
    extra?: Partial<Video>,
  ): Promise<void> {
    await this.repo.update(id, { status, ...extra });
  }

  async save(video: Video): Promise<Video> {
    return this.repo.save(video);
  }
}
