---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-06-28T11:26:00-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-06-28T11:27:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-28T11:27:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o módulo completo de vídeos no backend: upload de até 10GB via pre-signed URL, processamento assíncrono com FFmpeg (metadados + thumbnail), URL única por vídeo, streaming e download via redirect para MinIO pré-assinado, e infraestrutura nova (MinIO, Redis, worker) no Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose

**Description:** Instalar todas as dependências de produção da fase, criar os namespaces de config para storage e queue, estender o schema Joi, adicionar MinIO, Redis e video-worker ao Docker Compose, e criar o Dockerfile.worker.

**Technical actions:**

- Instalar dependências em `nestjs-project`:
  ```bash
  npm install @nestjs/bullmq bullmq @aws-sdk/client-s3 @aws-sdk/s3-request-presigner nanoid fluent-ffmpeg
  npm install --save-dev @types/fluent-ffmpeg
  ```
- Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo:
  - `STORAGE_ENDPOINT` (string, default `'http://minio:9000'`)
  - `STORAGE_ACCESS_KEY` (string, required)
  - `STORAGE_SECRET_KEY` (string, required)
  - `STORAGE_BUCKET_VIDEOS` (string, default `'videos'`)
  - `STORAGE_REGION` (string, default `'us-east-1'`)
  - `STORAGE_PRESIGNED_URL_EXPIRATION` (number, default `3600`) — TTL em segundos para pre-signed URLs de upload
  - `STORAGE_STREAM_URL_EXPIRATION` (number, default `3600`) — TTL em segundos para pre-signed URLs de streaming
- Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo:
  - `REDIS_HOST` (string, default `'redis'`)
  - `REDIS_PORT` (number, default `6379`)
- Atualizar `src/config/env.validation.ts` — adicionar todas as novas variáveis com seus defaults e tipos corretos (Joi)
- Atualizar `.env.example` com as novas variáveis e valores Docker-safe
- Adicionar ao `nestjs-project/compose.yaml`:
  - Serviço `minio` — image `minio/minio:latest`, ports `9000:9000` e `9001:9001`, env `MINIO_ROOT_USER/PASSWORD`, command `server /data --console-address ":9001"`, volume `minio_data:/data`
  - Serviço `redis` — image `redis:7-alpine`, port `6379:6379`
  - Serviço `video-worker` — build via `Dockerfile.worker`, depends_on `redis` e `minio`, env vars iguais à API, entrypoint `node dist/worker.js`
  - Adicionar `nestjs-api` depends_on `redis` e `minio`
  - Declarar volumes `minio_data`
- Criar `nestjs-project/Dockerfile.worker` — herda de Node.js 22, instala FFmpeg via `apt-get install -y ffmpeg`, copia `dist/` e roda `node dist/worker.js`
- Criar script `src/storage/init-bucket.ts` — conecta ao MinIO e cria o bucket `videos` se não existir (usando `CreateBucketCommand`); chamado no startup do worker

**Dependencies:** None

**Acceptance criteria:**
- `docker compose up -d` sobe API, DB, Mailpit, MinIO, Redis e video-worker sem erros
- MinIO Console acessível em `localhost:9001` com as credenciais configuradas
- Redis acessível em `localhost:6379`
- Aplicação (API) inicia sem erros com as novas env vars; env vars ausentes/inválidas causam erro Joi no bootstrap

---

### SI-03.2 — Video Entity, Repository, and Migration

**Description:** Criar a entidade `Video` com todos os campos necessários, o repositório TypeORM e a migration que cria a tabela `videos` com FK para `channels`.

**Technical actions:**

- Criar enum `VideoStatus` em `src/videos/enums/video-status.enum.ts`:
  ```typescript
  export enum VideoStatus {
    DRAFT = 'draft',
    PENDING = 'pending',
    PROCESSING = 'processing',
    READY = 'ready',
    ERROR = 'error',
  }
  ```
- Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com colunas:
  - `id` (uuid PK generated)
  - `slug` (varchar(11), unique, not null) — nanoid gerado na criação
  - `title` (varchar(255), nullable) — definido pelo usuário após upload
  - `storage_key` (varchar(500), nullable) — chave do objeto no MinIO (ex: `videos/channelId/videoId.mp4`)
  - `thumbnail_key` (varchar(500), nullable) — chave do thumbnail no MinIO
  - `status` (enum `VideoStatus`, default `DRAFT`)
  - `duration` (integer, nullable) — duração em segundos, extraída pelo worker
  - `size_bytes` (bigint, nullable) — tamanho do arquivo em bytes
  - `mime_type` (varchar(100), nullable)
  - `error_message` (text, nullable) — mensagem de erro do worker em caso de falha
  - `channel_id` (uuid, FK → channels, not null)
  - `created_at` (CreateDateColumn)
  - `updated_at` (UpdateDateColumn)
  - Relação `@ManyToOne(() => Channel, channel => channel.videos)` com `@JoinColumn({ name: 'channel_id' })`
- Adicionar `@OneToMany(() => Video, video => video.channel)` em `Channel` entity
- Criar `src/videos/repositories/videos.repository.ts` — wrapper TypeORM repository com métodos:
  - `findById(id: string): Promise<Video | null>`
  - `findBySlug(slug: string): Promise<Video | null>`
  - `findByChannelId(channelId: string): Promise<Video[]>`
  - `create(data: Partial<Video>): Promise<Video>`
  - `updateStatus(id: string, status: VideoStatus, extra?: Partial<Video>): Promise<void>`
- Gerar migration: `npm run migration:generate -- src/database/migrations/CreateVideos`
- Revisar o SQL gerado para garantir: coluna `slug` com constraint UNIQUE, enum correto no PostgreSQL, FK com index

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Constraint UNIQUE em slug, status default DRAFT, FK para channel, nullable fields |
| `src/videos/repositories/videos.repository.integration-spec.ts` | Integration | findBySlug, findByChannelId, updateStatus transitioning correctly |

**Dependencies:** SI-03.1

**Acceptance criteria:**
- `npm run migration:run` cria tabela `videos` com todas as colunas, índices e FK
- Inserir dois vídeos com o mesmo `slug` falha com unique constraint violation
- `status` default é `'draft'` sem set explícito
- Query sem JOIN não retorna `channel` populated (lazy relation)

---

### SI-03.3 — StorageModule (MinIO S3-compatible)

**Description:** Criar o módulo NestJS de storage que encapsula a interação com MinIO via AWS SDK, incluindo geração de pre-signed URLs para upload e para acesso (streaming/download).

**Technical actions:**

- Criar `src/storage/storage.module.ts` — `@Module` global com `StorageService` como provider exportado
- Criar `src/storage/storage.service.ts` com métodos:
  - `generateUploadPresignedUrl(key: string, contentType: string, expiresIn?: number): Promise<string>` — usa `PutObjectCommand` + `getSignedUrl`
  - `generateDownloadPresignedUrl(key: string, expiresIn?: number): Promise<string>` — usa `GetObjectCommand` + `getSignedUrl`
  - `deleteObject(key: string): Promise<void>` — usa `DeleteObjectCommand`
  - `objectExists(key: string): Promise<boolean>` — usa `HeadObjectCommand`
- Configurar `S3Client` com `endpoint` do MinIO, `forcePathStyle: true`, credenciais injetadas via `storageConfig`
- O bucket é criado no startup se não existir (via `init-bucket.ts` chamado no `OnModuleInit` do StorageService)
- Criar `src/storage/storage.service.spec.ts` — unit test mockando o `S3Client`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | generateUploadPresignedUrl retorna URL com params corretos; deleteObject chama DeleteObjectCommand |
| `src/storage/storage.module.spec.ts` | Unit | Module compila com S3Client e StorageService wired |

**Dependencies:** SI-03.1

**Acceptance criteria:**
- `StorageService` injeta corretamente a config de storage
- Pre-signed URL gerada inclui o host do MinIO e expiração configurável
- `objectExists()` retorna `false` para objetos inexistentes

---

### SI-03.4 — VideosModule: Upload Flow (Initiate → Complete)

**Description:** Criar o módulo de vídeos com o fluxo completo de upload: o cliente solicita uma URL de upload (cria rascunho), faz o PUT direto ao MinIO, e notifica a API da conclusão (muda status para `pending` e enfileira o job de processamento).

**Technical actions:**

- Criar `src/videos/videos.module.ts` — importa `TypeOrmModule.forFeature([Video])`, `StorageModule`, `BullModule.registerQueue({ name: 'video-processing' })`, `ChannelsModule`
- Criar `src/videos/dto/initiate-upload.dto.ts`:
  - `filename: string` (required, @IsString)
  - `mimeType: string` (required, @IsString — ex: `video/mp4`)
  - `sizeBytes: number` (required, @IsNumber, @Min(1))
- Criar `src/videos/dto/initiate-upload-response.dto.ts`:
  - `videoId: string`
  - `uploadUrl: string`
  - `slug: string`
- Criar `src/videos/videos.service.ts` com métodos:
  - `initiateUpload(channelId: string, dto: InitiateUploadDto): Promise<InitiateUploadResponseDto>` — gera nanoid slug, cria vídeo em `DRAFT`, gera pre-signed URL de upload para MinIO, retorna videoId + uploadUrl + slug
  - `completeUpload(videoId: string, channelId: string): Promise<void>` — verifica ownership, verifica que objeto existe no MinIO (`objectExists`), muda status para `PENDING`, enfileira job BullMQ `video-processing`
  - `findBySlug(slug: string): Promise<Video>` — retorna vídeo ou lança `VideoNotFoundException`
  - `getStreamUrl(videoId: string): Promise<string>` — verifica status `READY`, gera pre-signed URL de download com `ResponseContentType: 'video/mp4'`
  - `getDownloadUrl(videoId: string): Promise<string>` — igual ao stream mas com `ResponseContentDisposition: 'attachment'`
- Criar `src/videos/videos.controller.ts` com endpoints:
  - `POST /videos/upload` (protected) → `initiateUpload` — retorna 201 com `{ videoId, uploadUrl, slug }`
  - `POST /videos/:id/complete` (protected) → `completeUpload` — retorna 204
  - `GET /videos/:slug/stream` (@Public) → redirect 302 para pre-signed URL
  - `GET /videos/:slug/download` (@Public) → redirect 302 para pre-signed URL com attachment
  - `GET /videos/:slug` (@Public) → retorna metadata do vídeo
- Criar exceções de domínio:
  - `VideoNotFoundException` (404, `VIDEO_NOT_FOUND`)
  - `VideoNotReadyException` (409, `VIDEO_NOT_READY`)
  - `VideoProcessingException` (422, `VIDEO_PROCESSING_FAILED`)
  - `VideoOwnershipException` (403, `VIDEO_OWNERSHIP_DENIED`)
  - Registrar em `src/common/exceptions/domain.exception.ts`
- Registrar `VideosModule` no `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | initiateUpload gera slug e chama storage; completeUpload verifica ownership e enfileira job; getStreamUrl verifica status READY |
| `src/videos/videos.service.integration-spec.ts` | Integration | fluxo completo draft→pending com DB real e MinIO real |
| `test/videos.e2e-spec.ts` | E2E | POST /videos/upload (201, auth required), POST /videos/:id/complete (204), GET /videos/:slug (200), GET /videos/:slug/stream (302), validation wiring |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**
- `POST /videos/upload` requer autenticação; retorna 401 sem token
- `POST /videos/upload` retorna 201 com `{ videoId, uploadUrl, slug }` onde `slug` tem 11 chars
- `POST /videos/:id/complete` muda status de `draft` para `pending`
- `POST /videos/:id/complete` de outro usuário retorna 403
- `GET /videos/:slug/stream` retorna 302 para URL MinIO
- `GET /videos/:slug/stream` retorna 409 se status não for `ready`

---

### SI-03.5 — Video Worker: Processing (FFmpeg + Thumbnail)

**Description:** Implementar o worker BullMQ que consome jobs de `video-processing`, processa o vídeo com FFmpeg (extrai metadados e gera thumbnail), faz upload do thumbnail ao MinIO e atualiza o status do vídeo no banco.

**Technical actions:**

- Criar `src/videos/processors/video-processing.processor.ts` — classe com decorator `@Processor('video-processing')`:
  - Método `process(job: Job<VideoProcessingJob>)`:
    1. Atualiza status para `PROCESSING`
    2. Download do vídeo do MinIO para temp file (`/tmp/video-<id>.<ext>`)
    3. Extrai metadados via `ffprobe`: `duration`, `size_bytes`, `codec_name`, `width`, `height`
    4. Gera thumbnail via `ffmpeg` no segundo 1: salva em `/tmp/thumb-<id>.jpg`
    5. Upload do thumbnail ao MinIO com chave `thumbnails/<channelId>/<videoId>.jpg`
    6. Atualiza vídeo no banco: status=`READY`, `duration`, `thumbnail_key`, `mime_type`
    7. Remove arquivos temporários
  - Em caso de erro: atualiza status para `ERROR` com `error_message`, remove temp files
  - Adicionar `@OnWorkerEvent('failed')` para log de falhas
- Criar `src/videos/types/video-processing-job.type.ts`:
  ```typescript
  export interface VideoProcessingJob {
    videoId: string;
    storageKey: string;
    channelId: string;
  }
  ```
- Criar `src/worker.ts` — entry point NestJS standalone que inicializa `VideoWorkerModule` (sem HTTP server)
- Criar `src/video-worker/video-worker.module.ts` — imports `ConfigModule`, `TypeOrmModule.forRootAsync`, `BullModule.forRootAsync`, `VideosModule`; sem controllers
- Atualizar `nest-cli.json` com `"entryFile": "main"` na app principal e adicionar app `worker` com `"entryFile": "worker"`; ou usar custom `nest build` command
- Adicionar `@OnModuleInit` no worker para criar bucket MinIO se não existir
- BullMQ retry config: `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processors/video-processing.processor.spec.ts` | Unit | Mocks FFmpeg e MinIO; verifica transição de status (PROCESSING → READY/ERROR); verifica upload de thumbnail; verifica cleanup de temp files em caso de erro |
| `src/videos/processors/video-processing.processor.integration-spec.ts` | Integration | Processa vídeo MP4 real com FFmpeg, gera thumbnail, verifica atualização no DB e objeto no MinIO |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**
- Worker processa um video MP4 pequeno (< 1MB para testes): status passa para `ready`, `duration` populado, `thumbnail_key` populado
- Erro de FFmpeg (arquivo corrompido) resulta em status `error` com `error_message` descritivo
- Arquivos temporários são removidos após processamento (sucesso ou falha)
- Retry é tentado 3 vezes com backoff exponencial antes de marcar como `error`

---

### SI-03.6 — Streaming, Download, and Public Video Endpoint

**Description:** Garantir que os endpoints de streaming e download funcionem corretamente para o cliente — redirect 302 para URL pre-assinada MinIO com suporte a Range — e que o endpoint de metadados do vídeo retorne os campos corretos.

**Technical actions:**

- Ajustar `GET /videos/:slug/stream` no controller:
  - Verificar status `READY`; se não, lançar `VideoNotReadyException`
  - Chamar `videosService.getStreamUrl(video.id)` — retorna pre-signed URL
  - Retornar HTTP 302 com `Location: <presigned-url>`
  - `@Public()` — sem autenticação
- Ajustar `GET /videos/:slug/download`:
  - Idêntico ao stream mas gera URL com `ResponseContentDisposition: attachment; filename="<slug>.mp4"`
  - Retornar HTTP 302 com `Location: <presigned-url>`
  - `@Public()` — sem autenticação
- Criar `src/videos/dto/video-response.dto.ts` — resposta pública do vídeo:
  - `id: string`, `slug: string`, `title: string | null`, `status: VideoStatus`, `duration: number | null`, `thumbnailUrl: string | null`, `channelId: string`, `createdAt: Date`
  - `thumbnailUrl` é gerado na hora: pre-signed URL do thumbnail_key (se existir)
- Endpoint `GET /videos/:slug` retorna `VideoResponseDto` com `@Public()`
- Adicionar `@ApiTags('videos')` e decorators Swagger em todos os endpoints
- Adicionar os novos endpoints à documentação OpenAPI exportada

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | GET /videos/:slug/stream redireciona 302 para URL MinIO; GET /videos/:slug/download inclui attachment; GET /videos/:slug retorna metadata; 409 quando não ready; 404 para slug inexistente |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**
- `GET /videos/:slug/stream` para vídeo `ready` retorna 302 com `Location` começando com `http://localhost:9000/videos/`
- `GET /videos/:slug/stream` para vídeo não `ready` retorna 409
- `GET /videos/:slug` retorna `{ id, slug, status, duration, thumbnailUrl, channelId }`
- `GET /videos/:slug` para slug inexistente retorna 404 com `{ statusCode: 404, error: 'VIDEO_NOT_FOUND' }`

---

### SI-03.7 — Definition of Done: TypeScript, Lint, Full Test Suite

**Description:** Garantir que todo o código compila sem erros TypeScript, lint passa e a suíte completa de testes (unit + integration + E2E) está verde.

**Technical actions:**

- Corrigir quaisquer erros TypeScript: `docker compose exec nestjs-api npx tsc --noEmit`
- Corrigir quaisquer erros de lint: `docker compose exec nestjs-api npm run lint`
- Rodar suíte completa unit + integration: `docker compose exec nestjs-api npm test -- --runInBand`
- Rodar suíte E2E: `docker compose exec nestjs-api npm run test:e2e`
- Atualizar `CLAUDE.md` com seção do módulo de vídeos, endpoints e infraestrutura nova

**Dependencies:** SI-03.1 a SI-03.6

**Acceptance criteria:**
- `npx tsc --noEmit` sai com código 0
- `npm run lint` sai sem erros
- Toda a suíte de testes está verde (0 failures)

---

## Technical Specifications

### Data Model

#### Tabela: `videos`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Identificador interno |
| slug | varchar(11) | UNIQUE, NOT NULL | nanoid gerado na criação; usado nas URLs públicas |
| title | varchar(255) | NULLABLE | Definido pelo usuário (fase 04) |
| storage_key | varchar(500) | NULLABLE | Chave MinIO: `videos/<channelId>/<videoId>.<ext>` |
| thumbnail_key | varchar(500) | NULLABLE | Chave MinIO: `thumbnails/<channelId>/<videoId>.jpg` |
| status | enum | NOT NULL, DEFAULT 'draft' | `draft | pending | processing | ready | error` |
| duration | integer | NULLABLE | Duração em segundos (extraída pelo worker) |
| size_bytes | bigint | NULLABLE | Tamanho do arquivo em bytes |
| mime_type | varchar(100) | NULLABLE | Ex: `video/mp4` |
| error_message | text | NULLABLE | Mensagem de erro do worker |
| channel_id | uuid | FK → channels(id), NOT NULL | Canal dono do vídeo |
| created_at | timestamptz | NOT NULL, auto | |
| updated_at | timestamptz | NOT NULL, auto | |

**Índices:** PK on `id`, UNIQUE on `slug`, INDEX on `channel_id`.

#### Relação com Channel

- `Channel` → `Video`: `@OneToMany(() => Video, video => video.channel)` (sem cascade delete — vídeos ficam ao canal mesmo se gerenciamento for alterado)
- `Video` → `Channel`: `@ManyToOne(() => Channel, channel => channel.videos)` com `@JoinColumn({ name: 'channel_id' })`

---

### API Contracts

#### POST /videos/upload

**Auth:** Required (Bearer JWT)

**Request Body:**
```json
{
  "filename": "my-video.mp4",
  "mimeType": "video/mp4",
  "sizeBytes": 1073741824
}
```

**Response 201:**
```json
{
  "videoId": "uuid-gerado",
  "slug": "dQw4w9WgXcQ",
  "uploadUrl": "http://minio:9000/videos/signed?X-Amz-Expires=3600&..."
}
```

**Response 401:** Token ausente ou inválido
**Response 400:** Payload inválido (validação)

---

#### POST /videos/:id/complete

**Auth:** Required (Bearer JWT) — deve ser o dono do canal que possui o vídeo

**Response 204:** Upload registrado como concluído; job enfileirado

**Response 403:** Vídeo não pertence ao canal do usuário autenticado
**Response 404:** Vídeo não encontrado
**Response 409:** Vídeo já processado ou em processamento (status != `draft`)

---

#### GET /videos/:slug

**Auth:** Public

**Response 200:**
```json
{
  "id": "uuid",
  "slug": "dQw4w9WgXcQ",
  "title": null,
  "status": "ready",
  "duration": 212,
  "thumbnailUrl": "http://minio:9000/thumbnails/signed?...",
  "channelId": "uuid",
  "createdAt": "2026-06-28T14:00:00Z"
}
```

**Response 404:** `{ "statusCode": 404, "error": "VIDEO_NOT_FOUND", "message": "Video not found" }`

---

#### GET /videos/:slug/stream

**Auth:** Public

**Response 302:** `Location: <pre-signed-MinIO-URL>` (MinIO suporta Range requests nativo)

**Response 404:** Vídeo não encontrado
**Response 409:** `VIDEO_NOT_READY` — vídeo ainda não processado

---

#### GET /videos/:slug/download

**Auth:** Public

**Response 302:** `Location: <pre-signed-MinIO-URL-with-attachment-disposition>`

**Response 404 / 409:** Igual ao stream

---

### Authorization Matrix

| Endpoint | Auth Required | Ownership Check | Notes |
|----------|---------------|-----------------|-------|
| POST /videos/upload | Yes (JWT) | Implícito — usa canal do user autenticado | — |
| POST /videos/:id/complete | Yes (JWT) | Yes — channel_id do vídeo = canal do user | 403 se não for dono |
| GET /videos/:slug | No (@Public) | — | Qualquer um pode ver metadata |
| GET /videos/:slug/stream | No (@Public) | — | Qualquer um pode streamar |
| GET /videos/:slug/download | No (@Public) | — | Qualquer um pode baixar |

---

### Error Catalog

| Error Code | HTTP Status | Trigger |
|------------|-------------|---------|
| `VIDEO_NOT_FOUND` | 404 | Slug ou ID inexistente |
| `VIDEO_NOT_READY` | 409 | Tentativa de stream/download antes de status=ready |
| `VIDEO_OWNERSHIP_DENIED` | 403 | Completar upload de vídeo de outro canal |
| `VIDEO_PROCESSING_FAILED` | 422 | Erro fatal no worker (exposto via status field, não como exceção HTTP direta) |
| `VALIDATION_ERROR` | 400 | DTO inválido (herdado da fase 02) |

---

### Events / Messages

#### Fila: `video-processing` (BullMQ + Redis)

**Job type: `process-video`**

**Payload:**
```typescript
interface VideoProcessingJob {
  videoId: string;        // UUID do vídeo
  storageKey: string;     // Chave MinIO do vídeo original
  channelId: string;      // ID do canal (para organizar thumbnail)
}
```

**Fluxo de vida do job:**
1. `POST /videos/:id/complete` → `queue.add('process-video', payload)`
2. Worker recebe job, atualiza vídeo para `PROCESSING`
3. Worker processa (download → ffprobe → ffmpeg thumbnail → upload thumb → update DB)
4. Sucesso: vídeo atualizado para `READY` com metadados
5. Falha: BullMQ tenta até 3x (backoff exponencial 5s). Após 3 falhas: vídeo atualizado para `ERROR` com `error_message`

**Retry policy:**
```typescript
{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
```

**Dead letter:** Jobs após 3 falhas ficam em `failed` no BullMQ (visíveis via Bull Board se habilitado).

---

## Dependency Map

```
SI-03.1 (deps + infra)
  └── SI-03.2 (entity + migration)
        ├── SI-03.3 (storage module)
        │     └── SI-03.4 (videos module: upload flow)
        │           └── SI-03.5 (worker: processing)
        │                 └── SI-03.6 (streaming + download)
        │                       └── SI-03.7 (DoD: tsc + lint + full suite)
        └── SI-03.3 (storage module)
```

Execução: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7

---

## Deliverables

1. **Infraestrutura:** `nestjs-project/compose.yaml` atualizado com MinIO, Redis e video-worker; `Dockerfile.worker` criado
2. **Config:** `src/config/storage.config.ts`, `src/config/queue.config.ts`; `env.validation.ts` e `.env.example` atualizados
3. **Entidade e Migration:** `src/videos/entities/video.entity.ts`, migration `<timestamp>-CreateVideos.ts`
4. **StorageModule:** `src/storage/storage.module.ts`, `src/storage/storage.service.ts`
5. **VideosModule:** `src/videos/videos.module.ts`, `src/videos/videos.controller.ts`, `src/videos/videos.service.ts`, DTOs, exceções, repositório
6. **Worker:** `src/videos/processors/video-processing.processor.ts`, `src/worker.ts`, `src/video-worker/video-worker.module.ts`
7. **Testes:** Unit specs, integration specs, E2E spec (`test/videos.e2e-spec.ts`)
8. **Progresso:** `docs/phases/phase-03-videos/progress.md` atualizado
9. **CLAUDE.md:** Atualizado com módulo Videos, endpoints, fila e storage
