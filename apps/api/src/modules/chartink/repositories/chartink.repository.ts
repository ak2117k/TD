import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface UpsertScannerInput {
  scanUrl: string;
  scanName: string;
  alertName: string | null;
  firedAt: Date;
}

export interface CreateAlertInput {
  scannerId: string;
  triggeredAt: Date;
  rawPayload: Prisma.InputJsonValue;
}

export interface CreateAlertSetupInput {
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  kind: 'setup' | 'no-setup' | 'unresolved' | 'error' | 'mtf-misaligned';
  setupId: string | null;
  rejectReason: string | null;
  // Scoring + lot sizing (added 2026-05-12)
  score?: number | null;
  lotCount?: number | null;
  scoreBreakdown?: unknown;
}

@Injectable()
export class ChartinkRepository {
  private readonly logger = new Logger(ChartinkRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertScanner(input: UpsertScannerInput): Promise<{ id: string }> {
    const row = await this.prisma.chartinkScanner.upsert({
      where: { scanUrl: input.scanUrl },
      create: {
        scanUrl: input.scanUrl,
        scanName: input.scanName,
        alertName: input.alertName,
        firstSeenAt: input.firedAt,
        lastFiredAt: input.firedAt,
        fireCount: 1,
      },
      update: {
        scanName: input.scanName,
        alertName: input.alertName,
        lastFiredAt: input.firedAt,
        fireCount: { increment: 1 },
      },
      select: { id: true },
    });
    return row;
  }

  async createAlert(input: CreateAlertInput): Promise<{ id: string }> {
    return this.prisma.chartinkAlert.create({
      data: {
        scannerId: input.scannerId,
        triggeredAt: input.triggeredAt,
        rawPayload: input.rawPayload,
      },
      select: { id: true },
    });
  }

  async getAlertWithSetups(alertId: string) {
    return this.prisma.chartinkAlert.findUnique({
      where: { id: alertId },
      include: { setups: true, scanner: true },
    });
  }

  async createAlertSetup(input: CreateAlertSetupInput): Promise<void> {
    await this.prisma.chartinkAlertSetup.create({
      data: {
        alertId: input.alertId,
        symbol: input.symbol,
        token: input.token,
        hitPrice: input.hitPrice,
        kind: input.kind,
        setupId: input.setupId,
        rejectReason: input.rejectReason,
        score: input.score ?? null,
        lotCount: input.lotCount ?? null,
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
    });
  }

  async listScanners() {
    return this.prisma.chartinkScanner.findMany({
      orderBy: { lastFiredAt: 'desc' },
    });
  }

  async listRecentAlerts(limit = 50) {
    return this.prisma.chartinkAlert.findMany({
      orderBy: { receivedAt: 'desc' },
      take: limit,
      include: {
        scanner: { select: { scanName: true, scanUrl: true } },
        setups: { select: { kind: true } },
      },
    });
  }

  async findChartinkSourceForSetup(setupId: string) {
    const row = await this.prisma.chartinkAlertSetup.findFirst({
      where: { setupId },
      include: { alert: { include: { scanner: true } } },
    });
    if (!row) return null;
    return {
      scannerName: row.alert.scanner.scanName,
      scannerUrl: row.alert.scanner.scanUrl,
      alertId: row.alertId,
    };
  }
}
