import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { NseSectorIndexService } from './nse-sector-index.service';

const NIFTY_IT_CSV = `Company Name,Industry,Symbol,Series,ISIN Code
Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021
HCL Technologies Ltd.,Information Technology,HCLTECH,EQ,INE860A01027
Wipro Ltd.,Information Technology,WIPRO,EQ,INE075A01022`;

const NIFTY_BANK_CSV = `Company Name,Industry,Symbol,Series,ISIN Code
HDFC Bank Ltd.,Financial Services,HDFCBANK,EQ,INE040A01034
ICICI Bank Ltd.,Financial Services,ICICIBANK,EQ,INE090A01021`;

describe('NseSectorIndexService', () => {
  let service: NseSectorIndexService;
  let mockHttp: { get: jest.Mock };

  beforeEach(async () => {
    mockHttp = { get: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [NseSectorIndexService, { provide: HttpService, useValue: mockHttp }],
    }).compile();
    module.useLogger(false);
    service = module.get(NseSectorIndexService);
  });

  it('parses NSE CSV correctly', async () => {
    // Only the IT slug returns a CSV; other 14 sectors 404. This isolates
    // the assertion to IT mappings — the plan's `mockReturnValue` would
    // hand the same CSV to all 15 URLs and the numeric-key iteration order
    // of Object.entries would make the last sector win.
    mockHttp.get.mockImplementation((url: string) => {
      if (url.includes('niftyitlist')) return of({ data: NIFTY_IT_CSV });
      return throwError(() => new Error('404'));
    });
    await service.refresh();
    expect(service.getSectorIndexForSymbol('INFY')).toBe('99926013');
    expect(service.getSectorIndexForSymbol('HCLTECH')).toBe('99926013');
    expect(service.getSectorIndexForSymbol('WIPRO')).toBe('99926013');
  });

  it('handles multiple sector CSVs (IT and BANK)', async () => {
    mockHttp.get.mockImplementation((url: string) => {
      if (url.includes('niftyitlist')) return of({ data: NIFTY_IT_CSV });
      if (url.includes('niftybanklist')) return of({ data: NIFTY_BANK_CSV });
      return throwError(() => new Error('404'));
    });
    await service.refresh();
    expect(service.getSectorIndexForSymbol('INFY')).toBe('99926013');
    expect(service.getSectorIndexForSymbol('HDFCBANK')).toBe('99926009');
  });

  it('returns null for unknown symbols (no static fallback match either)', async () => {
    mockHttp.get.mockImplementation((url: string) => {
      if (url.includes('niftyitlist')) return of({ data: NIFTY_IT_CSV });
      return throwError(() => new Error('404'));
    });
    await service.refresh();
    expect(service.getSectorIndexForSymbol('UNKNOWNSTOCK')).toBeNull();
  });

  it('strips series suffixes from symbol lookup', async () => {
    mockHttp.get.mockImplementation((url: string) => {
      if (url.includes('niftyitlist')) return of({ data: NIFTY_IT_CSV });
      return throwError(() => new Error('404'));
    });
    await service.refresh();
    expect(service.getSectorIndexForSymbol('INFY-EQ')).toBe('99926013');
    expect(service.getSectorIndexForSymbol('INFY-BE')).toBe('99926013');
  });

  it('falls back to static map when all NSE fetches fail', async () => {
    mockHttp.get.mockReturnValue(throwError(() => new Error('NSE timeout')));
    await service.refresh();
    // Dynamic map empty; static fallback should still cover RELIANCE
    expect(service.getSectorIndexForSymbol('RELIANCE')).toBe('99926019');
  });

  it('preserves previous map on a partial-failure refresh (0 symbols loaded)', async () => {
    mockHttp.get.mockImplementation((url: string) => {
      if (url.includes('niftyitlist')) return of({ data: NIFTY_IT_CSV });
      return throwError(() => new Error('404'));
    });
    await service.refresh(); // first refresh succeeds
    expect(service.getSectorIndexForSymbol('INFY')).toBe('99926013');

    // Subsequent refresh: all fetches throw
    mockHttp.get.mockReset();
    mockHttp.get.mockReturnValue(throwError(() => new Error('NSE down')));
    await service.refresh();
    expect(service.getSectorIndexForSymbol('INFY')).toBe('99926013'); // still cached
  });

  it('reports stats including lastRefreshAt', async () => {
    mockHttp.get.mockImplementation((url: string) => {
      if (url.includes('niftyitlist')) return of({ data: NIFTY_IT_CSV });
      return throwError(() => new Error('404'));
    });
    expect(service.getStats().count).toBe(0);
    expect(service.getStats().lastRefreshAt).toBeNull();
    await service.refresh();
    expect(service.getStats().count).toBeGreaterThan(0);
    expect(service.getStats().lastRefreshAt).toBeInstanceOf(Date);
  });
});
