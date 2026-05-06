import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { ChartinkIngestService } from '../chartink-ingest.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { ChartinkWebhookDto } from '../../dto/chartink-webhook.dto';

describe('ChartinkIngestService', () => {
  let service: ChartinkIngestService;
  let repo: { upsertScanner: jest.Mock; createAlert: jest.Mock };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    repo = {
      upsertScanner: jest.fn().mockResolvedValue({ id: 'scanner-1' }),
      createAlert: jest.fn().mockResolvedValue({ id: 'alert-1' }),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChartinkIngestService,
        { provide: ChartinkRepository, useValue: repo },
        { provide: getQueueToken('chartink-process'), useValue: queue },
      ],
    }).compile();

    service = moduleRef.get(ChartinkIngestService);
  });

  function dto(overrides: Partial<ChartinkWebhookDto> = {}): ChartinkWebhookDto {
    return {
      stocks: 'RELIANCE,INFY,TCS',
      trigger_prices: '1467.4,1612.0,3890.5',
      triggered_at: '2:34 pm',
      scan_name: 'Short term breakouts',
      scan_url: 'short-term-breakouts',
      alert_name: 'Alert for Short term breakouts',
      webhook_url: 'http://example/wh',
      ...overrides,
    };
  }

  it('parses stocks + trigger_prices into parallel pairs and enqueues', async () => {
    await service.ingest(dto());
    expect(repo.upsertScanner).toHaveBeenCalledTimes(1);
    expect(repo.createAlert).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const job = queue.add.mock.calls[0][1];
    expect(job).toMatchObject({
      alertId: 'alert-1',
      hits: [
        { symbol: 'RELIANCE', hitPrice: 1467.4 },
        { symbol: 'INFY', hitPrice: 1612.0 },
        { symbol: 'TCS', hitPrice: 3890.5 },
      ],
    });
  });

  it('trims whitespace around CSV entries', async () => {
    await service.ingest(dto({ stocks: ' RELIANCE , INFY ', trigger_prices: ' 1.0 , 2.0 ' }));
    const hits = queue.add.mock.calls[0][1].hits;
    expect(hits).toEqual([
      { symbol: 'RELIANCE', hitPrice: 1.0 },
      { symbol: 'INFY', hitPrice: 2.0 },
    ]);
  });

  it('throws when stocks and trigger_prices have different lengths', async () => {
    await expect(
      service.ingest(dto({ stocks: 'A,B,C', trigger_prices: '1,2' })),
    ).rejects.toThrow(/length mismatch/i);
    expect(repo.upsertScanner).not.toHaveBeenCalled();
  });

  it('derives triggeredAt from today IST + clock string', async () => {
    await service.ingest(dto({ triggered_at: '2:34 pm' }));
    const triggeredAt = repo.createAlert.mock.calls[0][0].triggeredAt as Date;
    expect(triggeredAt).toBeInstanceOf(Date);
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(triggeredAt.getTime() + istOffsetMs);
    expect(istDate.getUTCHours()).toBe(14);
    expect(istDate.getUTCMinutes()).toBe(34);
  });
});
