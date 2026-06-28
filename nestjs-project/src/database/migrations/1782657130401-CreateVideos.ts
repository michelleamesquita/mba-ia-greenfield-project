import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1782657130401 implements MigrationInterface {
  name = 'CreateVideos1782657130401';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."videos_status_enum" AS ENUM(
        'draft', 'pending', 'processing', 'ready', 'error'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "videos" (
        "id"            uuid               NOT NULL DEFAULT uuid_generate_v4(),
        "slug"          character varying(11)  NOT NULL,
        "title"         character varying(255) DEFAULT NULL,
        "storage_key"   character varying(500) DEFAULT NULL,
        "thumbnail_key" character varying(500) DEFAULT NULL,
        "status"        "public"."videos_status_enum" NOT NULL DEFAULT 'draft',
        "duration"      integer            DEFAULT NULL,
        "size_bytes"    bigint             DEFAULT NULL,
        "mime_type"     character varying(100) DEFAULT NULL,
        "error_message" text               DEFAULT NULL,
        "channel_id"    uuid               NOT NULL,
        "created_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_videos" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_videos_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_videos_channel" FOREIGN KEY ("channel_id")
          REFERENCES "channels"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_videos_channel_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
