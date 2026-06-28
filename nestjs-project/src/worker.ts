import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { VideoWorkerModule } from './video-worker/video-worker.module';

async function bootstrap() {
  const logger = new Logger('VideoWorker');

  const app = await NestFactory.createApplicationContext(VideoWorkerModule, {
    logger: ['log', 'warn', 'error'],
  });

  app.enableShutdownHooks();

  logger.log('Video worker started and listening for jobs...');
}

bootstrap().catch((err) => {
  console.error('Fatal error starting video worker', err);
  process.exit(1);
});
