import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  HeadBucketCommand: jest.fn(),
  CreateBucketCommand: jest.fn(),
}));

describe('StorageModule', () => {
  it('should compile and provide StorageService', async () => {
    process.env.STORAGE_ACCESS_KEY = 'test';
    process.env.STORAGE_SECRET_KEY = 'test-secret';

    const module = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(storageConfig), StorageModule],
    })
      .overrideProvider(StorageService)
      .useValue({
        onModuleInit: jest.fn(),
        generateUploadPresignedUrl: jest.fn(),
        generateDownloadPresignedUrl: jest.fn(),
        deleteObject: jest.fn(),
        objectExists: jest.fn(),
        getObjectUrl: jest.fn(),
      })
      .compile();

    const service = module.get(StorageService);
    expect(service).toBeDefined();
  });
});
