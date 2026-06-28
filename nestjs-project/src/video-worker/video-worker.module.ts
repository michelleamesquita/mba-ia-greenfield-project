import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import swaggerConfig from '../config/swagger.config';
import { envValidationSchema } from '../config/env.validation';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from '../videos/processors/video-processing.processor';
import { VideosRepository } from '../videos/repositories/videos.repository';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        storageConfig,
        queueConfig,
        swaggerConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        entities: [Video],
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.redisHost,
          port: cfg.redisPort,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
  ],
  providers: [VideosRepository, VideoProcessingProcessor],
})
export class VideoWorkerModule {}
