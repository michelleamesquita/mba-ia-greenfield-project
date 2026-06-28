import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessingProcessor } from './processors/video-processing.processor';
import { VideosRepository } from './repositories/videos.repository';
import { VideosController } from './videos.controller';
import { VideosService, VIDEO_PROCESSING_QUEUE } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
    ChannelsModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideosRepository, VideoProcessingProcessor],
  exports: [VideosService, VideosRepository],
})
export class VideosModule {}
