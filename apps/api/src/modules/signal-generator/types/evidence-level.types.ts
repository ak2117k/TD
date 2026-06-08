export type EvidenceKind = 'VOLUME' | 'HISTORY' | 'OI_CALL' | 'OI_PUT' | 'ROUND';

export interface EvidenceLevel {
  price: number;
  side: 'resistance' | 'support';
  score: number;          // 0–100
  kinds: EvidenceKind[];
  soft: boolean;
  distancePct: number;
}

export interface LevelCandidate {
  price: number;
  kind: EvidenceKind;
  score: number;
}
