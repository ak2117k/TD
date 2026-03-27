import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  Min,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum OrderSideDto {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderTypeDto {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOPLOSS = 'STOPLOSS',
  STOPLOSS_MARKET = 'STOPLOSS_MARKET',
}

export enum PositionTypeDto {
  INTRADAY = 'INTRADAY',
  DELIVERY = 'DELIVERY',
  CARRYFORWARD = 'CARRYFORWARD',
}

export class ExecuteTradeDto {
  @IsString()
  symbol: string;

  @IsString()
  token: string;

  @IsString()
  exchange: string;

  @IsEnum(OrderSideDto)
  side: OrderSideDto;

  @IsEnum(OrderTypeDto)
  orderType: OrderTypeDto;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsNumber()
  price?: number;

  @IsOptional()
  @IsNumber()
  triggerPrice?: number;

  @IsEnum(PositionTypeDto)
  positionType: PositionTypeDto;

  @IsOptional()
  @IsNumber()
  stoploss?: number;

  @IsOptional()
  @IsNumber()
  target?: number;

  @IsOptional()
  @IsString()
  signalId?: string;

  @IsOptional()
  @IsString()
  strategy?: string;
}

export class ModifyTradeDto {
  @IsOptional()
  @IsNumber()
  stoploss?: number;

  @IsOptional()
  @IsNumber()
  target?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}

export class CloseTradeDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CloseAllTradesDto {
  @IsString()
  reason: string;
}

export class TradeFilterDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  strategy?: string;

  @IsOptional()
  @IsString()
  segment?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isPaperTrade?: boolean;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

/** Return type for risk validation. */
export interface RiskValidation {
  allowed: boolean;
  reason?: string;
}

/** Daily risk status snapshot. */
export interface DailyRiskStatus {
  dailyLossUsed: number;
  dailyLossLimit: number;
  positionsUsed: number;
  positionsLimit: number;
  capitalUsed: number;
  killSwitchActive: boolean;
}

/** Daily performance data shape. */
export interface DailyPerformanceData {
  date: Date;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  maxDrawdown: number;
  capitalDeployed: number;
}
