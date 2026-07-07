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

  it('parses stocks + trigger_prices and fans out ONE process-hit job per hit', async () => {
    await service.ingest(dto());
    expect(repo.upsertScanner).toHaveBeenCalledTimes(1);
    expect(repo.createAlert).toHaveBeenCalledTimes(1);
    // One 'process-hit' job per stock (fan-out), not a single 'process' job.
    expect(queue.add).toHaveBeenCalledTimes(3);
    const names = queue.add.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['process-hit', 'process-hit', 'process-hit']);
    const jobs = queue.add.mock.calls.map((c) => c[1]);
    expect(jobs).toEqual([
      { alertId: 'alert-1', hit: { symbol: 'RELIANCE', hitPrice: 1467.4 }, scanName: 'Short term breakouts', scannerCategory: undefined },
      { alertId: 'alert-1', hit: { symbol: 'INFY', hitPrice: 1612.0 }, scanName: 'Short term breakouts', scannerCategory: undefined },
      { alertId: 'alert-1', hit: { symbol: 'TCS', hitPrice: 3890.5 }, scanName: 'Short term breakouts', scannerCategory: undefined },
    ]);
  });

  it('trims whitespace around CSV entries', async () => {
    await service.ingest(dto({ stocks: ' RELIANCE , INFY ', trigger_prices: ' 1.0 , 2.0 ' }));
    const hits = queue.add.mock.calls.map((c) => c[1].hit);
    expect(hits).toEqual([
      { symbol: 'RELIANCE', hitPrice: 1.0 },
      { symbol: 'INFY', hitPrice: 2.0 },
    ]);
  });

  it('enqueues every per-hit job with priority 1 for an ANAND_SWING scanner', async () => {
    repo.upsertScanner.mockResolvedValue({ id: 'scanner-1', category: 'ANAND_SWING' });
    await service.ingest(dto({ stocks: 'RELIANCE,INFY', trigger_prices: '1.0,2.0' }));
    expect(queue.add).toHaveBeenCalledTimes(2);
    for (const call of queue.add.mock.calls) {
      expect(call[0]).toBe('process-hit');
      expect(call[1].scannerCategory).toBe('ANAND_SWING');
      expect(call[2]).toEqual({ priority: 1 });
    }
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

  it('returns same alertId for identical payloads within 60s', async () => {
    repo.createAlert.mockResolvedValueOnce({ id: 'a1' });
    const first = await service.ingest(dto());
    expect(first.alertId).toBe('a1');

    const second = await service.ingest(dto());
    expect(second.alertId).toBe('a1');
    expect(second.hitCount).toBe(first.hitCount);

    expect(repo.createAlert).toHaveBeenCalledTimes(1);
    expect(repo.upsertScanner).toHaveBeenCalledTimes(1);
    // 3 stocks in the default dto → 3 per-hit jobs on the first ingest, none
    // on the deduped second.
    expect(queue.add).toHaveBeenCalledTimes(3);
  });

  it('creates new alert when payload differs in any tracked field', async () => {
    repo.createAlert
      .mockResolvedValueOnce({ id: 'a1' })
      .mockResolvedValueOnce({ id: 'a2' })
      .mockResolvedValueOnce({ id: 'a3' });

    // differs in `stocks`
    await service.ingest(dto({ stocks: 'A', trigger_prices: '10' }));
    await service.ingest(dto({ stocks: 'B', trigger_prices: '10' }));
    // differs in `trigger_prices` only (same stocks as call #2)
    await service.ingest(dto({ stocks: 'B', trigger_prices: '20' }));

    expect(repo.createAlert).toHaveBeenCalledTimes(3);
    expect(queue.add).toHaveBeenCalledTimes(3);
  });

  it('creates new alert after dedup window expires', async () => {
    repo.createAlert
      .mockResolvedValueOnce({ id: 'a1' })
      .mockResolvedValueOnce({ id: 'a2' });

    const first = await service.ingest(dto());
    expect(first.alertId).toBe('a1');

    // Simulate dedup window expiry by clearing the in-memory cache.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).recentPayloads.clear();

    const second = await service.ingest(dto());
    expect(second.alertId).toBe('a2');
    expect(repo.createAlert).toHaveBeenCalledTimes(2);
  });
});
