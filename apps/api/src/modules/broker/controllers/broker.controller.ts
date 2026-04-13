import { Controller, Get, Post, Body } from '@nestjs/common';
import { BrokerService } from '../services/broker.service';
import { SaveBrokerCredentialsDto } from '../dto/broker.dto';

@Controller('api/broker')
export class BrokerController {
  constructor(private readonly brokerService: BrokerService) {}

  @Post('credentials')
  async saveCredentials(@Body() dto: SaveBrokerCredentialsDto) {
    return this.brokerService.saveCredentials(dto);
  }

  @Post('connect')
  async connect() {
    return this.brokerService.connect();
  }

  @Post('disconnect')
  async disconnect() {
    return this.brokerService.disconnect();
  }

  @Get('status')
  async getStatus() {
    return this.brokerService.getStatus();
  }

  @Get('account')
  async getAccountInfo() {
    return this.brokerService.getAccountInfo();
  }

  @Get('credentials')
  async getSavedCredentials() {
    return this.brokerService.getSavedCredentials();
  }
}
