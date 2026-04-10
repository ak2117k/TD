import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InsightsService } from '../services/insights.service';
import { RequestInsightDto } from '../dto/request-insight.dto';

@ApiTags('insights')
@Controller('api/insights')
export class InsightsController {
  constructor(private readonly service: InsightsService) {}

  @Post('request')
  @ApiOperation({ summary: 'Request an AI insight for a section (idempotent)' })
  async request(@Body() dto: RequestInsightDto) {
    const row = await this.service.requestInsight(
      dto.sectionKey,
      dto.contextKey,
      dto.contextData as object,
    );
    return row;
  }

  @Get(':sectionKey/:contextKey')
  @ApiOperation({ summary: 'Get latest insight for a section + context' })
  async getLatest(
    @Param('sectionKey') sectionKey: string,
    @Param('contextKey') contextKey: string,
  ) {
    return this.service.getLatest(sectionKey, contextKey);
  }
}
