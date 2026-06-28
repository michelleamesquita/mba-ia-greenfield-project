import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min } from 'class-validator';

export class InitiateUploadDto {
  @ApiProperty({ example: 'my-video.mp4' })
  @IsString()
  filename: string;

  @ApiProperty({ example: 'video/mp4' })
  @IsString()
  mimeType: string;

  @ApiProperty({ example: 1073741824 })
  @IsNumber()
  @Min(1)
  sizeBytes: number;
}
