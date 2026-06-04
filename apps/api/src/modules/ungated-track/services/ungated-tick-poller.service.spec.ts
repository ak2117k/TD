import { Test } from '@nestjs/testing';
import { UngatedTickPoller } from './ungated-tick-poller.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedWatchService } from './ungated-watch.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';

describe('UngatedTickPoller.pollOpenPositions', () => {
  let poller: UngatedTickPoller;
  let adapter: { getLtpsBatch: jest.Mock };
  let repo: { findAllActive: jest.Mock };
  let watch: { onTick: jest.Mock };

  beforeEach(async () => {
    adapter = { getLtpsBatch: jest.fn() };
    repo = { findAllActive: jest.fn() };
    watch = { onTick: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedTickPoller,
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedWatchService, useValue: watch },
        { provide: UngatedTradeExecutionService, useValue: { closeTrade: jest.fn() } },
      ],
    }).compile();
    poller = mod.get(UngatedTickPoller);
  });

  it('no-ops when no entries are TRADED', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'WATCHING', token: '111', exchange: 'NSE' },
      { status: 'STOPPED', token: '222', exchange: 'NSE' },
    ]);
    await poller.pollOpenPositions();
    expect(adapter.getLtpsBatch).not.toHaveBeenCalled();
    expect(watch.onTick).not.toHaveBeenCalled();
  });

  it('batches all TRADED tokens for the same exchange into one quote call', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'TRADED', token: '111', exchange: 'NSE' },
      { status: 'TRADED', token: '222', exchange: 'NSE' },
      { status: 'TRADED', token: '333', exchange: 'NSE' },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([
      ['111', 100.5],
      ['222', 200.5],
      ['333', 300.5],
    ]));
    await poller.pollOpenPositions();
    expect(adapter.getLtpsBatch).toHaveBeenCalledTimes(1);
    expect(adapter.getLtpsBatch).toHaveBeenCalledWith(
      'NSE',
      expect.arrayContaining(['111', '222', '333']),
    );
    expect(watch.onTick).toHaveBeenCalledTimes(3);
    expect(watch.onTick).toHaveBeenCalledWith('111', 100.5, expect.any(Date));
    expect(watch.onTick).toHaveBeenCalledWith('222', 200.5, expect.any(Date));
    expect(watch.onTick).toHaveBeenCalledWith('333', 300.5, expect.any(Date));
  });

  it('tokens missing from the batch response are silently dropped (no onTick)', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'TRADED', token: '111', exchange: 'NSE' },
      { status: 'TRADED', token: '222', exchange: 'NSE' },
    ]);
    // Broker only returned a quote for 111 — 222 missing (e.g. delisted, halted)
    adapter.getLtpsBatch.mockResolvedValue(new Map([['111', 100.5]]));
    await poller.pollOpenPositions();
    expect(watch.onTick).toHaveBeenCalledTimes(1);
    expect(watch.onTick).toHaveBeenCalledWith('111', 100.5, expect.any(Date));
  });

  it('an onTick failure for one symbol does NOT abort the others', async () => {
    repo.findAllActive.mockResolvedValue([
      { status: 'TRADED', token: '111', exchange: 'NSE' },
      { status: 'TRADED', token: '222', exchange: 'NSE' },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['111', 100], ['222', 200]]));
    watch.onTick.mockImplementationOnce(() => { throw new Error('boom'); });
    await poller.pollOpenPositions();
    // Both tokens should have been attempted — the second one despite the
    // first throwing.
    expect(watch.onTick).toHaveBeenCalledTimes(2);
  });
});
