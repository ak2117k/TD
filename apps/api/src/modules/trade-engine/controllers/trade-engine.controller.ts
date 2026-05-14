import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { TradeExecutionService } from '../services/trade-execution.service';
import { PositionManagerService } from '../services/position-manager.service';
import { RiskManagerService } from '../services/risk-manager.service';
import { PaperTradeService } from '../services/paper-trade.service';
import { TradeRepository } from '../repositories/trade.repository';
import {
  ExecuteTradeDto,
  ModifyTradeDto,
  CloseTradeDto,
  CloseAllTradesDto,
  TradeFilterDto,
} from '../dto/trade.dto';

@Controller('api/trades')
export class TradeEngineController {
  private readonly logger = new Logger(TradeEngineController.name);

  constructor(
    private readonly tradeExecutionService: TradeExecutionService,
    private readonly positionManagerService: PositionManagerService,
    private readonly riskManagerService: RiskManagerService,
    private readonly tradeRepository: TradeRepository,
    private readonly paperTradeService: PaperTradeService,
  ) {}

  /**
   * GET /api/trades/paper-account — Virtual cash balance, deployed capital,
   * unrealized P&L, and total equity for the paper-trading account. Polled
   * by the UI badge.
   */
  @Get('paper-account')
  async getPaperAccount() {
    return this.paperTradeService.getAccount();
  }

  /**
   * POST /api/trades/execute — Execute a new trade.
   */
  @Post('execute')
  async executeTrade(@Body() dto: ExecuteTradeDto) {
    this.logger.log(
      `Execute trade request: ${dto.side} ${dto.symbol} x${dto.quantity}`,
    );
    return this.tradeExecutionService.executeTrade(dto);
  }

  /**
   * POST /api/trades/close-all — Kill switch: close all open positions.
   */
  @Post('close-all')
  @HttpCode(HttpStatus.OK)
  async closeAllPositions(@Body() dto: CloseAllTradesDto) {
    this.logger.warn(`Close all positions: ${dto.reason}`);
    return this.tradeExecutionService.closeAllPositions(dto.reason);
  }

  /**
   * POST /api/trades/sync-positions — Sync positions with broker.
   */
  @Post('sync-positions')
  @HttpCode(HttpStatus.OK)
  async syncPositions() {
    await this.positionManagerService.syncWithBroker();
    return { message: 'Position sync complete' };
  }

  /**
   * GET /api/trades/open — Get all open trades.
   */
  @Get('open')
  async getOpenTrades() {
    return this.tradeExecutionService.getOpenTrades();
  }

  /**
   * GET /api/trades/positions — Live positions with real-time P&L.
   */
  @Get('positions')
  async getPositions() {
    return this.positionManagerService.getPositions();
  }

  /**
   * GET /api/trades/risk-status — Current daily risk usage.
   */
  @Get('risk-status')
  async getRiskStatus() {
    return this.riskManagerService.getDailyRiskStatus();
  }

  /**
   * GET /api/trades/daily-pnl — Today's P&L summary.
   */
  @Get('daily-pnl')
  async getDailyPnl() {
    return this.positionManagerService.getDailyPerformance();
  }

  /**
   * GET /api/trades — Trade history with filters (paginated).
   */
  @Get()
  async getTradeHistory(@Query() filters: TradeFilterDto) {
    return this.tradeExecutionService.getTradeHistory(filters);
  }

  /**
   * GET /api/trades/:id — Single trade detail.
   */
  @Get(':id')
  async getTradeById(@Param('id') id: string) {
    return this.tradeExecutionService.getTradeById(id);
  }

  /**
   * POST /api/trades/:id/close — Close a specific trade.
   *
   * Body accepts the structured M5 form `{exitReasonTag, exitNotes}` and
   * still tolerates the legacy `{reason}` shape for older clients.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  async closeTrade(
    @Param('id') id: string,
    @Body() dto: CloseTradeDto,
  ) {
    return this.tradeExecutionService.closeTrade(id, {
      exitReasonTag: dto.exitReasonTag,
      exitNotes: dto.exitNotes,
      reason: dto.reason,
    });
  }

  /**
   * PUT /api/trades/:id — Modify trade (stoploss / target / quantity).
   */
  @Put(':id')
  async modifyTrade(
    @Param('id') id: string,
    @Body() dto: ModifyTradeDto,
  ) {
    return this.tradeExecutionService.modifyTrade(id, dto);
  }
}
