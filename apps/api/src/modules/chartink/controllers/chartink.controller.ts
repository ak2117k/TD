import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';

@Controller('api/chartink')
export class ChartinkController {
  constructor(private readonly repo: ChartinkRepository) {}

  @Get('scanners')
  async listScanners() {
    return this.repo.listScanners();
  }

  @Get('alerts')
  async listAlerts(@Query('limit') limit?: string) {
    const n = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) : 50;
    return this.repo.listRecentAlerts(n);
  }

  @Get('alerts/:id')
  async getAlert(@Param('id') id: string) {
    const alert = await this.repo.getAlertWithSetups(id);
    if (!alert) throw new NotFoundException(`Chartink alert ${id} not found`);
    return alert;
  }
}
