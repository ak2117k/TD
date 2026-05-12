import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { SECTOR_INDICES } from '@td/shared/constants';

/**
 * Maps sector-index name (lower-case, no spaces) to NSE archives CSV slug.
 * URL pattern: https://archives.nseindia.com/content/indices/ind_<slug>.csv
 *
 * Verified accessible 2026-05-12: HTTP 200 for all 9 below.
 * Other indices we'd want (PSU BANK, PVT BANK, FIN SERVICE, HEALTHCARE,
 * CONSUMER) have less-stable URL slugs; if a fetch 404s we skip silently.
 */
const SECTOR_CSV_SLUGS: Record<string, string> = {
  '99926009': 'niftybanklist',
  '99926013': 'niftyitlist',
  '99926015': 'niftyfmcglist',
  '99926017': 'niftypharmalist',
  '99926019': 'niftyenergylist',
  '99926021': 'niftyautolist',
  '99926023': 'niftymetallist',
  '99926027': 'niftyrealtylist',
  '99926029': 'niftyinfralist',
  '99926031': 'niftymedialist',
  '99926033': 'niftypsubanklist',
  '99926035': 'niftyprivatebanklist',
  '99926011': 'niftyfinancelist',
  '99926041': 'niftyhealthcarelist',
  '99926039': 'niftyconsumerdurableslist',
};

/**
 * Hardcoded fallback used if NSE fetches all fail (boot before first
 * refresh, NSE down, network blocked). Copied from the previous static
 * map in chartink-scoring.service.ts so behavior degrades gracefully.
 */
const STATIC_FALLBACK: Record<string, string> = {
  HDFCBANK: '99926009', ICICIBANK: '99926009', SBIN: '99926009', AXISBANK: '99926009',
  KOTAKBANK: '99926009', INDUSINDBK: '99926009', BAJFINANCE: '99926011',
  TCS: '99926013', INFY: '99926013', WIPRO: '99926013', HCLTECH: '99926013',
  TECHM: '99926013', LTIM: '99926013',
  MARUTI: '99926021', TATAMOTORS: '99926021', M_M: '99926021', BAJAJ_AUTO: '99926021',
  RELIANCE: '99926019', ONGC: '99926019', GAIL: '99926019', BPCL: '99926019',
  IOC: '99926019', HINDPETRO: '99926019', NTPC: '99926019', POWERGRID: '99926019',
  TATASTEEL: '99926023', HINDALCO: '99926023', JSWSTEEL: '99926023',
  VEDL: '99926023', HINDCOPPER: '99926023', HINDZINC: '99926023',
  SUNPHARMA: '99926017', DIVISLAB: '99926017', DRREDDY: '99926017', CIPLA: '99926017',
  HINDUNILVR: '99926015', ITC: '99926015', NESTLEIND: '99926015', BRITANNIA: '99926015',
};

@Injectable()
export class NseSectorIndexService implements OnModuleInit {
  private readonly logger = new Logger(NseSectorIndexService.name);
  private symbolToSector: Map<string, string> = new Map();
  private lastRefreshAt: Date | null = null;

  constructor(private readonly http: HttpService) {}

  async onModuleInit() {
    // Don't block startup — fetch async, fall back to static if it takes time.
    this.refresh().catch((err) => {
      this.logger.warn(`Initial sector refresh failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  /** Cron at 06:00 IST daily (00:30 UTC) — well before market open. */
  @Cron('30 0 * * 1-5')
  async dailyRefresh() {
    this.logger.log('Daily NSE sector-index refresh triggered');
    await this.refresh();
  }

  /**
   * Manually trigger a refresh. Returns count of symbols loaded.
   * Public for ops endpoints + tests.
   */
  async refresh(): Promise<number> {
    const fresh = new Map<string, string>();
    let okCount = 0;
    let failCount = 0;

    for (const [sectorToken, slug] of Object.entries(SECTOR_CSV_SLUGS)) {
      try {
        const symbols = await this.fetchSectorConstituents(slug);
        for (const sym of symbols) {
          fresh.set(sym.toUpperCase(), sectorToken);
        }
        okCount++;
      } catch (err) {
        failCount++;
        this.logger.warn(`NSE ${slug}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (fresh.size === 0) {
      this.logger.warn(`NSE refresh got 0 symbols — keeping previous map (${this.symbolToSector.size} entries)`);
      return 0;
    }

    this.symbolToSector = fresh;
    this.lastRefreshAt = new Date();
    this.logger.log(`NSE refresh: ${fresh.size} symbols across ${okCount} sectors (${failCount} sectors unreachable)`);
    return fresh.size;
  }

  /**
   * Look up sector index token for a stock symbol. Returns null if not found.
   * Bare-symbol lookup (case-insensitive). Strips series suffixes like -EQ/-BE
   * before matching, since Chartink sends bare names.
   */
  getSectorIndexForSymbol(symbol: string): string | null {
    if (!symbol) return null;
    const bare = symbol.toUpperCase().replace(/-(EQ|BE|BL|IV|RL)$/, '');
    // Try dynamic map first, then static fallback
    return this.symbolToSector.get(bare) ?? STATIC_FALLBACK[bare] ?? null;
  }

  /** For ops/admin endpoints. */
  getStats(): { count: number; lastRefreshAt: Date | null } {
    return { count: this.symbolToSector.size, lastRefreshAt: this.lastRefreshAt };
  }

  private async fetchSectorConstituents(slug: string): Promise<string[]> {
    const url = `https://archives.nseindia.com/content/indices/ind_${slug}.csv`;
    const response = await firstValueFrom(
      this.http.get<string>(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/csv,*/*',
        },
        responseType: 'text',
        timeout: 15_000,
      }),
    );
    return this.parseConstituentsCsv(response.data);
  }

  /**
   * Parse NSE's constituent CSV. Format (verified 2026-05-12):
   *   Company Name,Industry,Symbol,Series,ISIN Code
   *   Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021
   *   ...
   * Returns the list of `Symbol` values.
   */
  private parseConstituentsCsv(csv: string): string[] {
    const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const headerCols = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const symbolIdx = headerCols.findIndex((c) => c === 'symbol');
    if (symbolIdx < 0) return [];
    const symbols: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvLine(lines[i]);
      if (cols.length > symbolIdx && cols[symbolIdx]) {
        symbols.push(cols[symbolIdx].trim());
      }
    }
    return symbols;
  }

  /** Minimal CSV line parser handling quoted fields (company names contain commas). */
  private parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }
}
