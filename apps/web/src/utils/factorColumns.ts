/**
 * The 10 ChartinkScoringService scoring factors, in fixed display order.
 * The /watch table (`WatchTable.tsx`) and the /signals/rejections table
 * (`RejectionsTab.tsx`) both read from this single list so the two views
 * always agree visually. Edit here, not in either page.
 */
export const FACTOR_COLUMNS: ReadonlyArray<{ name: string; short: string }> = [
  { name: 'Index aligned',        short: 'Idx'  },
  { name: 'Sector aligned',       short: 'Sect' },
  { name: 'Relative strength',    short: 'RS'   },
  { name: 'Price vs 20-EMA',      short: 'EMA'  },
  { name: 'SuperTrend match',     short: 'ST'   },
  { name: 'MACD on 1d',           short: 'M1d'  },
  { name: 'MACD on 5m',           short: 'M5m'  },
  { name: 'MACD on 1m',           short: 'M1m'  },
  { name: 'S/R room',             short: 'S/R'  },
  { name: 'Volume confirmation',  short: 'Vol'  },
];
