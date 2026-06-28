---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-28T10:58:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-28T11:25:00-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-28T10:58:00-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-28T10:58:00-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo (título, descrição, categoria), visibilidade público/unlisted, painel de gerenciamento, thumbnail customizada, interações sociais (likes, comentários), frontend UI de upload e player — todos previstos em fases posteriores.

**Deliverables:** Upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — interface de upload e player de vídeo são escopo de fases futuras.

**Sequencing notes:** Depends on Fase 01 (configuração base) e Fase 02 (auth, users, channels — o vídeo pertence a um canal).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (prior)
- **Phase 04:** Gerenciamento de Vídeos e Canal (next)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.x, bullmq@^5.x, ioredis@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy | decided | A (Pre-Signed URL via @aws-sdk/client-s3) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Worker Architecture | decided | A (worker.ts no mesmo projeto) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (nanoid, coluna slug) | nanoid@^5.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Streaming Strategy | decided | A (HTTP 302 → pre-signed URL MinIO) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Video Processing Tools | decided | A (fluent-ffmpeg + FFmpeg via Dockerfile) | fluent-ffmpeg@^2.x, @types/fluent-ffmpeg@^2.x |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (5 estados enum: draft/pending/processing/ready/error) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis com @nestjs/bullmq — Integração oficial NestJS com decorator-based processors, retry automático e Bull Board para monitoramento. Redis tem footprint pequeno em Docker. Para processamento de vídeo assíncrono single-instance, BullMQ oferece o melhor custo-benefício sem configuração AMQP complexa.

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, `ioredis@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Pre-Signed URL via @aws-sdk/client-s3 — É o padrão da indústria para uploads a S3/MinIO. A API nunca toca os bytes do arquivo: gera a URL pré-assinada, cadastra o rascunho, e o cliente faz o PUT direto ao MinIO. Elimina o gargalo de memória/CPU na API para uploads grandes.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** worker.ts entry point no mesmo nestjs-project — Compartilha entidades, configs e repositórios sem duplicação. O Compose adiciona um serviço `video-worker` buildando a mesma imagem Docker mas rodando `node dist/worker.js`.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** nanoid, length 11 — URL pública curta e amigável, padrão em plataformas de vídeo. Dependência mínima. Constraint UNIQUE na coluna garante a invariante.

**Libraries:** `nanoid@^5.x`

### phase-03-videos/TD-05

**Recommendation:** HTTP 302 redirect para pre-signed URL MinIO com TTL de 1 hora — Elimina o gargalo de I/O na API. MinIO suporta Range requests nativo. A URL exposta é temporária.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** fluent-ffmpeg + FFmpeg instalado via Dockerfile — Mais completo que ffmpeg-static em termos de suporte a codecs. O Dockerfile do worker instala via `apt-get install -y ffmpeg`. `fluent-ffmpeg` oferece API clara para extração e thumbnail.

**Libraries:** `fluent-ffmpeg@^2.x`, `@types/fluent-ffmpeg@^2.x`

### phase-03-videos/TD-07

**Recommendation:** 4 estados (draft, pending, processing, ready/error) — Alinhado com o AGENT.md ("pré-cadastro automático do vídeo como rascunho"). Granularidade suficiente para feedback de status na UI e para controle de publicação em fases futuras.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** @nestjs/config com registerAs — Oficial, core-team-maintained, garantia de compatibilidade NestJS 11. O padrão registerAs() resolve sharing entre AppModule e TypeORM CLI.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi para validação de env — Integração first-class com @nestjs/config via validationSchema, zero wiring customizado.

**Libraries:** `joi@^17.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards com @nestjs/jwt — Guardas JWT customizados protegem todos os endpoints de vídeo (exceto streaming/download que aceitam acesso anônimo).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter `{ statusCode, error, message }` — Todos os erros do módulo Videos seguem o mesmo contrato de resposta estabelecido na Fase 02.

**Libraries:** —

## Inherited Conventions

- Backend config usa `@nestjs/config` com namespaced `registerAs(name, () => ({...}))` factories — um arquivo por domínio em `src/config/`. _(from phase 01)_
- Env variables validadas por Joi schema em `src/config/env.validation.ts`. _(from phase 01)_
- Config injetado via `ConfigType<typeof xxxConfig>` e `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` com `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Cada domínio tem seu próprio módulo (`VideosModule`) registrado no `AppModule`. _(from phase 01)_
- DomainException base class com filtro global — erros do módulo Videos lançam subclasses de `DomainException`. _(from phase 02)_
- `@Public()` decorator em endpoints que não requerem autenticação. _(from phase 02)_
- Guard JWT global (`JwtAuthGuard` como `APP_GUARD`) — todos os endpoints são protegidos por default; use `@Public()` para exceções. _(from phase 02)_
- Migrations versionadas com timestamp — nunca usar `synchronize: true` em produção. _(from phase 01)_
- Testes: `*.spec.ts` (unit), `*.integration-spec.ts` (integração com DB), `*.e2e-spec.ts` (E2E via supertest). _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` não inicializado na fase 02; UI inicia em fase futura. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Reprodução via streaming (sem necessidade de download completo) — frontend player | deferred | Player e interface de vídeo são escopo da Fase 05. Backend streaming endpoint é implementado nesta fase. | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário — botão no frontend | deferred | Botão de download na UI é escopo da Fase 05. Endpoint de download implementado nesta fase. | phase-03-videos/TD-05 |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`video.entity.ts`) | Integration: constraints, defaults, relação com Channel |
| Service com branching + DB (`videos.service.ts`) | Unit: branch logic (mock repo) + Integration: DB contract |
| Service com side-effect (storage, queue) | Integration: MinIO local + Redis/BullMQ reais |
| Module com configured imports (`BullModule`, `TypeOrmModule`) | Unit: compilation test |
| Controller (`videos.controller.ts`) | E2E via supertest |
| DTO validation | E2E: um teste de validação por endpoint |
| Worker processor (`video-processing.processor.ts`) | Unit: mock FFmpeg + mock storage; Integration: processamento real |

### next-frontend

_Deferred subproject — testing requirements will be defined when the testing-guide skill is created._
