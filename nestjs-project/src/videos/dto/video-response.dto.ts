import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoStatus } from '../enums/video-status.enum';

export class VideoResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  slug: string;

  @ApiPropertyOptional()
  title: string | null;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiPropertyOptional()
  duration: number | null;

  @ApiPropertyOptional()
  thumbnailUrl: string | null;

  @ApiProperty()
  channelId: string;

  @ApiProperty()
  createdAt: Date;
}
