---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-28
scope_description: "Upload de vídeos de até 10GB, object storage, fila de processamento assíncrono, worker FFmpeg, geração de thumbnail, URL única e streaming."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend que entrega todos os endpoints de vídeo (upload, streaming, download, processamento), infraestrutura de fila/worker e object storage. É o único subprojeto com mudanças nesta fase.
- `next-frontend/` — Frontend deferred: interface de vídeo (upload UI, player) é escopo de fases posteriores. Sem decisão técnica aberta neste documento.

---

## TD-01: Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O project plan marca explicitamente a fila de processamento como TBD ("Message Queue (TBD)"). Esta é a principal decisão de stack da fase. O worker de vídeo precisa consumir jobs de processamento de forma assíncrona, com suporte a retry, dead-letter e monitoramento. A escolha impacta a infraestrutura Docker Compose, o módulo NestJS e o worker.

**Options:**

### Option A: BullMQ + Redis (@nestjs/bullmq)

- BullMQ é uma fila de jobs Node.js baseada em Redis, com suporte nativo a NestJS via `@nestjs/bullmq`. Jobs são armazenados em listas Redis (sorted sets), com retry automático e dead-letter queue configuráveis por decorator.
- **Pros:** Integração oficial NestJS (decorators `@Processor`, `@OnWorkerEvent`), UI de monitoramento disponível (Bull Board), retry + backoff configurável, Redis é tecnologia amplamente conhecida e suporta múltiplos padrões. API de alto nível com rate limiting e concurrency por fila.
- **Cons:** Adiciona Redis como dependência de infraestrutura. Redis como broker não é tão robusto quanto AMQP para garantias de entrega em cenários de crash extremo (mas adequado para processamento de vídeo assíncrono).

### Option B: RabbitMQ (AMQP via @nestjs/microservices)

- RabbitMQ é um message broker AMQP com garantias fortes de entrega, exchanges e routing por bindings. NestJS suporta via `@nestjs/microservices` com transporte AMQP.
- **Pros:** Garantias AMQP fortes (ack/nack, durability, message persistence). Suporte a routing complexo (exchanges, bindings). Mais robusto para cenários de mensageria entre múltiplos serviços.
- **Cons:** Configuração mais complexa (exchanges, bindings, vhosts). `@nestjs/microservices` usa padrão request-response por default — job queues requerem configuração adicional. Overhead de AMQP desnecessário para caso de uso simples de fila de processamento. Sem integração com retry/backoff tão fluida quanto BullMQ.

### Option C: Bull (versão anterior do BullMQ)

- Bull é o predecessor do BullMQ, amplamente usado no ecossistema NestJS via `@nestjs/bull`. BullMQ é a versão v2 reescrita do mesmo projeto.
- **Pros:** Mais maduro, muita documentação e exemplos no ecossistema NestJS.
- **Cons:** Bull está em modo de manutenção; BullMQ é o sucessor ativo recomendado pelos mesmos autores. `@nestjs/bull` usa a lib legada. Para novos projetos, BullMQ é a escolha oficial.

**Recommendation:** **Option A (BullMQ + Redis)** — Integração oficial NestJS com decorator-based processors, retry automático e Bull Board para monitoramento. Redis tem footprint pequeno em Docker e é amplamente conhecido. Para processamento de vídeo assíncrono single-instance, BullMQ oferece o melhor custo-benefício: sem configuração AMQP complexa, com garantias suficientes (ack, retry, dead-letter).

**Decision:** A (BullMQ + Redis / @nestjs/bullmq)

---

## TD-02: Upload Strategy para Arquivos de Até 10GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Enviar arquivos de 10GB pela API (body da requisição HTTP) não é viável: tranca a memória do processo, satura a rede interna e cria timeouts. A estratégia de upload define como o arquivo chega ao storage sem passar pelo processo da API. Esta decisão impacta o fluxo de endpoint, o contrato de API e a experiência de upload.

**Options:**

### Option A: Upload Direto ao MinIO via Pre-Signed URL (Multipart Presigned)

- A API gera uma URL pré-assinada do MinIO (válida por tempo limitado). O cliente faz o upload do arquivo diretamente ao MinIO usando essa URL (HTTP PUT), sem passar pela API. Para arquivos grandes (>5GB), MinIO suporta multipart upload com múltiplas URLs pré-assinadas por parte.
- **Pros:** API nunca recebe os bytes do arquivo — processo não é bloqueado. Escalável para qualquer tamanho de arquivo. Padrão da indústria (S3 usa o mesmo mecanismo). O worker pode processar direto do MinIO. Suportado nativamente pelo AWS SDK (S3-compatible).
- **Cons:** O cliente precisa de lógica para fazer PUT para a URL pré-assinada (fora do padrão `multipart/form-data`). Em caso de upload interrompido, partes incompletas ficam no MinIO até expiração.

### Option B: Multipart Upload via API (Streaming)

- O cliente faz `multipart/form-data` para a API. A API usa streaming (`@nestjs/platform-express` + Multer em modo streaming, sem buffer) para repassar o arquivo ao MinIO enquanto recebe.
- **Pros:** Contrato de API mais convencional (form-data). API controla o upload e pode rejeitar antes de enviar ao storage.
- **Cons:** Arquivo trafega pela API — mesmo em streaming, o processo fica ocupado durante toda a transferência (minutos para 10GB). Risco de timeout na requisição HTTP. Multer tem limitações de streaming com arquivos muito grandes. Não escala horizontalmente sem sticky sessions.

### Option C: TUS Protocol (Resumable Upload)

- TUS é um protocolo de upload resumível (RFC-like). Existem libs NestJS (`nestjs-tus`) e clientes JavaScript (`tus-js-client`).
- **Pros:** Suporte nativo a retomada de upload após falha de conexão. Padrão aberto.
- **Cons:** Requer servidor TUS ou integração customizada com MinIO (MinIO não fala TUS nativo — precisaria de proxy ou servidor TUS separado). Adiciona complexidade de infraestrutura significativa. O frontend TUS client é mais complexo. Overkill para o escopo desta fase (10GB com rede estável é razoável sem resumabilidade).

**Recommendation:** **Option A (Pre-Signed URL)** — É o padrão da indústria para uploads a S3/MinIO. A API nunca toca os bytes do arquivo: gera a URL pré-assinada, cadastra o rascunho, e o cliente faz o PUT direto ao MinIO. Elimina o gargalo de memória/CPU na API para uploads grandes. O AWS SDK `@aws-sdk/client-s3` suporta `createPresignedPost` e `getSignedUrl` com multipart nativo, ambos compatíveis com MinIO.

**Decision:** A (Pre-Signed URL via @aws-sdk/client-s3)

---

## TD-03: Worker Architecture

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O worker consome jobs da fila BullMQ, processa o vídeo com FFmpeg e atualiza o banco. A decisão é onde o código do worker roda: mesmo projeto NestJS (entry point separado), aplicação NestJS separada no mesmo repo, ou serviço completamente desacoplado. Impacta a estrutura de arquivos, o Dockerfile e o Compose.

**Options:**

### Option A: Mesmo projeto NestJS com entry point separado (`worker.ts`)

- O código do worker vive em `nestjs-project/src/` como um módulo NestJS (`VideoWorkerModule`). Um arquivo `worker.ts` cria uma aplicação NestJS configurada apenas para consumo de fila (sem HTTP). O Compose tem um serviço `video-worker` que roda `node dist/worker.js` no mesmo container buildado.
- **Pros:** Compartilha entidades TypeORM, configs, serviços e migrations com a API — sem duplicação. Build único. Qualquer mudança na entidade Video é automaticamente refletida no worker. Menor overhead de repositório.
- **Cons:** O build é mais acoplado — uma mudança na API re-builda o worker. Monolito mais difícil de escalar independentemente (mas aceitável para a fase inicial).

### Option B: Aplicação NestJS separada (`video-worker/`) no mesmo monorepo

- Criar um diretório `video-worker/` com seu próprio `package.json`, `tsconfig.json` e código NestJS. Compartilharia apenas tipos/contratos via um eventual `packages/` shared.
- **Pros:** Isolamento de dependências. Escala e faz deploy independentemente.
- **Cons:** Duplicação de entidades, configs e código de acesso ao banco. Dois `package.json`, dois sets de dependências, dois Dockerfiles para o mesmo projeto. Overkill para esta fase — o monorepo de dois subprojetos já existe (API + frontend), não há necessidade de um terceiro agora.

### Option C: Script standalone (sem NestJS no worker)

- Um script Node.js puro que usa BullMQ diretamente, conecta ao DB via TypeORM standalone e processa jobs.
- **Pros:** Leve — sem overhead NestJS.
- **Cons:** Perde DI, config module, entities importadas. Duplica toda a camada de acesso a dados. Difícil de testar com o mesmo setup de testes do projeto.

**Recommendation:** **Option A (entry point `worker.ts` no mesmo projeto)** — Compartilha entidades, configs e repositórios sem duplicação. O Compose adiciona um serviço `video-worker` buildando a mesma imagem Docker mas rodando `node dist/worker.js`. Alinhado com o princípio de continuidade do projeto (reuse do que já existe).

**Decision:** A (worker.ts no mesmo nestjs-project, serviço separado no Compose)

---

## TD-04: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de um identificador público único para compor sua URL (ex: `/watch?v=dQw4w9WgXcQ` no YouTube). O UUID interno (PK) pode ser exposto, mas é longo e não amigável. A escolha impacta a coluna do banco, o endpoint de vídeo e a URL pública.

**Options:**

### Option A: nanoid (URL-safe, curto, collision-resistant)

- `nanoid` gera strings aleatórias URL-safe (letras + números, sem caracteres especiais). Length 11 = 64^11 ≈ 73 quadrilhões de IDs possíveis (mesma dimensão do YouTube). Sem dependência de DB para geração.
- **Pros:** Curto e amigável para URLs. Collision-resistant com length adequado. Sem chamada ao banco para geração. Algoritmo criptograficamente seguro. URL-safe por padrão.
- **Cons:** Requer checagem de unicidade no banco (constraint UNIQUE na coluna) para garantia absoluta em escala extrema.

### Option B: UUID v4 (já disponível no TypeORM/PostgreSQL)

- UUID v4 é o padrão do projeto para PKs (`@PrimaryGeneratedColumn('uuid')`). A URL do vídeo seria simplesmente o UUID.
- **Pros:** Zero dependências extras. O TypeORM já gera automaticamente. Garantia absoluta de unicidade.
- **Cons:** UUID tem 36 chars (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) — URL longa e não amigável. Expõe o padrão sequencial de criação (v4 é aleatório mas reconhecível como UUID). Menos profissional para URLs públicas.

### Option C: CUID2 (Collision-resistant unique IDs)

- CUID2 é uma alternativa ao UUID projetada para ser mais legível e collision-resistant. Gera strings de 24 chars com `@paralleldrive/cuid2`.
- **Pros:** Collision-resistant por design, sem coordenação entre instâncias. Mais curto que UUID.
- **Cons:** Adiciona uma dependência extra. Menos familiar que nanoid ou UUID. Length 24 ainda é mais longo que nanoid-11.

**Recommendation:** **Option A (nanoid)** — URL pública curta e amigável é standard em plataformas de vídeo. Length 11 com alphabet URL-safe de 64 chars oferece resistência a colisão suficiente para qualquer escala do projeto. Constraint UNIQUE na coluna garante a invariante. Dependência mínima (`nanoid` < 1KB, sem deps).

**Decision:** A (nanoid, length 11, coluna `slug` com constraint UNIQUE)

---

## TD-05: Streaming Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Streaming de vídeo requer que o player consiga buscar qualquer posição do arquivo (seek) sem baixar o arquivo inteiro. HTTP suporta isso via Range requests (RFC 7233, HTTP 206 Partial Content). A estratégia define como o cliente acessa o stream: se a API faz proxy, ou se o cliente acessa o MinIO diretamente via URL pré-assinada.

**Options:**

### Option A: Redirect para Pre-Signed URL do MinIO (com suporte a Range)

- A API gera uma URL pré-assinada temporária do MinIO (ex: válida 60 min) para o objeto de vídeo e retorna HTTP 302 redirect. O player faz Range requests diretamente ao MinIO. O MinIO suporta nativamente Range requests (206 Partial Content).
- **Pros:** API não fica em meio ao stream — sem uso de memória/CPU na API para streaming. MinIO lida com Range nativamente. URL expirada automaticamente após TTL. Padrão usado por S3 e plataformas de vídeo (Cloudflare Stream, Bunny, etc.).
- **Cons:** Expõe a URL do MinIO para o cliente (mas é temporária e assinada). O cliente vê a URL do MinIO no redirect, o que revela a localização do storage. Não é possível aplicar lógica de controle de acesso por requisição individual.

### Option B: API Proxy com Range Request Pass-Through

- A API recebe a requisição Range do cliente, faz a própria requisição Range ao MinIO internamente e retorna o conteúdo parcial ao cliente. A API implementa `206 Partial Content` como intermediária.
- **Pros:** URL do MinIO nunca exposta ao cliente. Controle total sobre o acesso (pode verificar autenticação por Range request). Transparente para o cliente — URL pública permanente.
- **Cons:** Todos os bytes do vídeo passam pela API — para múltiplos usuários simultâneos assistindo vídeos de 10GB, o processo da API fica saturado com I/O de streaming. Não escala sem múltiplas instâncias da API. Latência adicional (dois hops: cliente → API → MinIO).

### Option C: URL Pública Permanente do MinIO (sem autenticação)

- O bucket MinIO é configurado como público. A URL do vídeo aponta diretamente ao MinIO sem pre-signing.
- **Pros:** Simples — nenhuma lógica de URL na API.
- **Cons:** Sem controle de acesso. Qualquer pessoa com a URL pode acessar o vídeo para sempre. Não aceitável para uma plataforma com vídeos privados/unlisted (fases futuras).

**Recommendation:** **Option A (Redirect para Pre-Signed URL)** — Elimina o gargalo de I/O na API. MinIO suporta Range requests nativo. A URL exposta é temporária (TTL configurável). Para uma plataforma de vídeo com acesso anônimo (per fase 03), a URL pré-assinada temporária é suficiente — controle de acesso mais granular pode ser adicionado em fases futuras (fase 04/05) sem mudar a estratégia fundamental.

**Decision:** A (HTTP 302 redirect para pre-signed URL do MinIO com TTL de 1 hora)

---

## TD-06: Video Processing Tools

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa extrair metadados do vídeo (duração, resolução, codec) e gerar um thumbnail a partir de um frame. FFmpeg é o padrão da indústria para processamento de vídeo. A decisão é como integrar o FFmpeg no container do worker.

**Options:**

### Option A: fluent-ffmpeg + FFmpeg instalado no container Docker

- `fluent-ffmpeg` é uma wrapper Node.js para o binário FFmpeg. O container do worker instala o FFmpeg via `apt-get` ou usa uma imagem base com FFmpeg (`jrottenberg/ffmpeg` ou `linuxserver/ffmpeg`). `ffprobe` (parte do FFmpeg) extrai metadados.
- **Pros:** API fluent e bem documentada para comandos FFmpeg. Instalação via apt é simples no Dockerfile. ffprobe para metadados é parte do mesmo pacote. `@types/fluent-ffmpeg` disponível. Controle total sobre os comandos FFmpeg.
- **Cons:** O container do worker precisa ter FFmpeg instalado (imagem mais pesada). `fluent-ffmpeg` tem dependência do binário no sistema — requer configuração de PATH.

### Option B: ffmpeg-static + fluent-ffmpeg (binário bundled)

- `ffmpeg-static` é um pacote npm que inclui um binário FFmpeg pré-compilado para Linux/Mac/Windows. Combinado com `fluent-ffmpeg`, não requer instalação de FFmpeg no sistema.
- **Pros:** Zero dependência de sistema — o binário FFmpeg está no `node_modules`. Reproduzível: mesma versão FFmpeg em todos ambientes. Sem `apt-get` no Dockerfile.
- **Cons:** Pacote npm muito pesado (~80MB). O binário pré-compilado pode não ter todos os codecs (versão "static" tem menos features que o FFmpeg completo). Suporte limitado a formatos de vídeo específicos. Para produção, FFmpeg do sistema é mais completo.

### Option C: Serviço de transcodificação externo (AWS Elemental, Mux, etc.)

- Delegar o processamento de vídeo a um serviço cloud especializado via API.
- **Pros:** Sem gerenciamento de infraestrutura de processamento. Escalável automaticamente. Suporte a múltiplas qualidades/resoluções.
- **Cons:** Custo variável (pay-per-minute de processamento). Dependência de serviço externo. Não funciona offline. Fora do escopo de uma plataforma self-hosted local com Docker Compose.

**Recommendation:** **Option A (fluent-ffmpeg + FFmpeg instalado via Dockerfile)** — Mais completo que `ffmpeg-static` em termos de suporte a codecs. O Dockerfile do worker usa uma imagem Node.js com FFmpeg instalado via `apt-get install -y ffmpeg`. `fluent-ffmpeg` oferece API clara para comandos de extração e thumbnail. Approach padrão em plataformas self-hosted.

**Decision:** A (fluent-ffmpeg + FFmpeg via Dockerfile do worker)

---

## TD-07: Video Status Lifecycle

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O vídeo passa por estados ao longo do fluxo: é criado como rascunho, processado pelo worker e fica disponível (ou em erro). O ciclo de status afeta a entidade do banco, os endpoints da API (o que o cliente pode fazer em cada estado) e a lógica do worker. É uma decisão cross-component (DB schema + API + worker).

**Options:**

### Option A: 4 estados — `draft` → `pending` → `processing` → `ready` | `error`

- `draft`: vídeo criado, upload não concluído. `pending`: upload concluído, aguarda worker. `processing`: worker em andamento. `ready`: processamento concluído. `error`: falha no processamento.
- **Pros:** Granularidade suficiente para distinguir "upload não iniciado" de "aguardando fila" de "processando". Permite UI feedback preciso. O campo `status` da API reflete cada transição.
- **Cons:** 5 estados para gerenciar no worker e nas queries de API.

### Option B: 3 estados — `draft` → `processing` → `ready` | `error`

- `draft`: vídeo criado e upload concluído (sem distinguir pending). `processing`: worker ativo. `ready` | `error`: resultado.
- **Pros:** Mais simples — 4 estados em vez de 5.
- **Cons:** Perde a distinção entre "vídeo criado mas upload não concluído" e "vídeo aguardando processamento". Sem `draft`, não há como saber se o upload foi concluído ou não antes do worker pegar.

### Option C: 3 estados — `uploading` → `processing` → `ready` | `error`

- `uploading`: upload em andamento (criado, pré-assinado, mas upload não confirmado). `processing`: job na fila/worker ativo. `ready` | `error`: resultado.
- **Pros:** Clareza semântica: `uploading` indica upload não confirmado.
- **Cons:** Sem `draft` como conceito persistido — o AGENT.md especifica "pré-cadastro como rascunho". Perde a semântica de "rascunho" para edições futuras (fase 04).

**Recommendation:** **Option A (4 estados)** — Alinhado com o AGENT.md ("pré-cadastro automático do vídeo como rascunho"). `draft` é o estado inicial (pré-upload), `pending` indica upload confirmado aguardando worker, `processing` é o worker ativo, `ready`/`error` é o resultado. Esta granularidade é usada nas fases 04 e 05 para controle de publicação.

**Decision:** A (4 estados: `draft` | `pending` | `processing` | `ready` | `error`)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Backend | Upload Strategy | Pre-Signed URL | A (Pre-Signed URL via @aws-sdk/client-s3) |
| TD-03 | Backend | Worker Architecture | Entry point worker.ts no mesmo projeto | A (worker.ts + serviço Compose separado) |
| TD-04 | Backend | Unique Video URL Identifier | nanoid length 11 | A (nanoid, coluna `slug`) |
| TD-05 | Backend | Streaming Strategy | Redirect para Pre-Signed URL | A (HTTP 302 → pre-signed URL MinIO) |
| TD-06 | Backend | Video Processing Tools | fluent-ffmpeg + FFmpeg via Dockerfile | A (fluent-ffmpeg + apt install ffmpeg) |
| TD-07 | Backend | Video Status Lifecycle | 4 estados (draft→pending→processing→ready/error) | A (5 estados enum) |
