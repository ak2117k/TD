import { Test, type TestingModule } from '@nestjs/testing';
import { MtfAlignmentService } from './mtf-alignment.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

interface MockCandle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function makeCandles(closes: number[]): MockCandle[] {
  return closes.map((c, i) => ({
    timestamp: new Date(Date.UTC(2026, 4, 11, 9, 15 + i * 5)),
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1000,
  }));
}

describe('MtfAlignmentService', () => {
  let service: MtfAlignmentService;
  let mockAdapter: { getHistoricalData: jest.Mock };

  beforeEach(async () => {
    mockAdapter = { getHistoricalData: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MtfAlignmentService,
        { provide: AngelOneAdapterService, useValue: mockAdapter },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(MtfAlignmentService);
    // Patch the sleep to a no-op so tests don't take seconds.
    (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () =>
      Promise.resolve();
  });

  it('reports aligned UP when all 4 TFs are up', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions).toEqual({
      '1d': 'UP',
      '1h': 'UP',
      '15m': 'UP',
      '5m': 'UP',
    });
  });

  it('reports aligned DOWN when all 4 TFs are down', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 99]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('DOWN');
  });

  it('reports misaligned when even one TF disagrees', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 99]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.agreedDirection).toBeNull();
    expect(result.directions['15m']).toBe('DOWN');
  });

  it('counts equal closes as NEUTRAL and treats them as misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 100]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.directions['1d']).toBe('NEUTRAL');
  });

  it('treats insufficient candles (<2) as NEUTRAL → misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.directions['1d']).toBe('NEUTRAL');
  });

  it('treats broker fetch failure on any TF as NEUTRAL → misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockRejectedValueOnce(new Error('Angel timeout'))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.directions['1h']).toBe('NEUTRAL');
  });

  it('uses the prior bar when the most-recent bar is still forming', async () => {
    const candles = makeCandles([100, 101, 95]);
    candles[candles.length - 1].timestamp = new Date(Date.now() + 60_000);
    mockAdapter.getHistoricalData.mockResolvedValue(candles);
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
  });

  it('builds rejectReason summary when misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 99]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 99]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.summary).toContain('1d=UP');
    expect(result.summary).toContain('1h=DOWN');
    expect(result.summary).toContain('15m=UP');
    expect(result.summary).toContain('5m=DOWN');
  });

  it('calls getHistoricalData with the 4 expected timeframes', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 101]));
    await service.check('99926000', 'NSE');
    const calls = mockAdapter.getHistoricalData.mock.calls.map(
      (c: unknown[]) => c[2],
    );
    expect(calls).toEqual(['1d', '1h', '15m', '5m']);
  });
});
