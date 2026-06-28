# phase-03-videos — Library References

Bibliotecas novas fixadas para esta fase, com versões confirmadas via documentação oficial.

## nestjs-project

### @nestjs/bullmq

- **Version:** `^11.0.0`
- **Install:** `npm install @nestjs/bullmq bullmq`
- **Purpose:** Integração oficial NestJS com BullMQ — decorators `@Processor`, `@Process`, `@InjectQueue`
- **Config pattern:** `BullModule.forRootAsync({ ... })` + `BullModule.registerQueue({ name: 'video-processing' })`
- **Docs:** https://docs.nestjs.com/techniques/queues

### bullmq

- **Version:** `^5.0.0`
- **Install:** peer dep do @nestjs/bullmq
- **Purpose:** Core da fila — `Queue`, `Worker`, `Job` types

### ioredis

- **Version:** `^5.0.0`
- **Install:** `npm install ioredis`
- **Purpose:** Cliente Redis usado pelo BullMQ internamente; tipos disponíveis em `@types/ioredis` (bundled)

### @aws-sdk/client-s3

- **Version:** `^3.600.0`
- **Install:** `npm install @aws-sdk/client-s3`
- **Purpose:** S3-compatible client para MinIO — `PutObjectCommand`, `GetObjectCommand`, `DeleteObjectCommand`, `HeadObjectCommand`
- **Config:** `endpoint` aponta para MinIO (`http://minio:9000`), `forcePathStyle: true` (obrigatório para MinIO)

### @aws-sdk/s3-request-presigner

- **Version:** `^3.600.0`
- **Install:** `npm install @aws-sdk/s3-request-presigner`
- **Purpose:** Geração de pre-signed URLs — `getSignedUrl(client, command, { expiresIn })`

### nanoid

- **Version:** `^5.0.0`
- **Install:** `npm install nanoid`
- **Purpose:** Geração de slugs únicos URL-safe para vídeos — `nanoid(11)`
- **Note:** nanoid v5+ é ESM-only. Para uso em projeto CommonJS/tsconfig com `"module": "nodenext"`, importar via `import { nanoid } from 'nanoid'`. O projeto usa `"module": "nodenext"` — compatível.

### fluent-ffmpeg

- **Version:** `^2.1.3`
- **Install:** `npm install fluent-ffmpeg && npm install --save-dev @types/fluent-ffmpeg`
- **Purpose:** Wrapper Node.js para FFmpeg — extração de metadados via `ffprobe`, geração de thumbnail via `screenshots`
- **Prerequisite:** FFmpeg binário instalado no container Docker (`apt-get install -y ffmpeg`)

## Infraestrutura Docker

### MinIO

- **Image:** `minio/minio:latest`
- **Port:** `9000` (API S3), `9001` (Console UI)
- **Config:** `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`
- **Start command:** `server /data --console-address ":9001"`

### Redis

- **Image:** `redis:7-alpine`
- **Port:** `6379`
- **Purpose:** Backend do BullMQ

### video-worker

- **Build:** mesmo Dockerfile.dev da API mas com FFmpeg instalado
- **Entry point:** `node dist/worker.js` (após build `nest build`)
- **Note:** Dockerfile do worker deve instalar FFmpeg via `apt-get install -y ffmpeg`
