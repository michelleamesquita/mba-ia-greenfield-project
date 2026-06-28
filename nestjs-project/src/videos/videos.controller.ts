import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Initiate video upload — returns a pre-signed upload URL',
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<{ videoId: string; slug: string; uploadUrl: string }> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/complete')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Upload registered; processing job enqueued',
  })
  @ApiOperation({
    summary: 'Notify API that file upload to storage is complete',
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    await this.videosService.completeUpload(id, user.sub);
  }

  @Get(':slug')
  @Public()
  @ApiOkResponse({ type: VideoResponseDto })
  @ApiOperation({ summary: 'Get video metadata by slug' })
  async getVideo(@Param('slug') slug: string): Promise<VideoResponseDto> {
    return this.videosService.getVideoResponse(slug);
  }

  @Get(':slug/stream')
  @Public()
  @Redirect()
  @ApiOperation({ summary: 'Stream video — redirects to pre-signed MinIO URL' })
  async streamVideo(
    @Param('slug') slug: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamUrl(slug);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':slug/download')
  @Public()
  @Redirect()
  @ApiOperation({
    summary:
      'Download video — redirects to pre-signed MinIO URL with attachment',
  })
  async downloadVideo(
    @Param('slug') slug: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadUrl(slug);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
