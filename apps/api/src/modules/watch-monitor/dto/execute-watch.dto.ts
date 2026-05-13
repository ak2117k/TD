import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class ExecuteWatchDto {
  @IsEnum(['paper', 'live'] as const)
  mode!: 'paper' | 'live';

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}
