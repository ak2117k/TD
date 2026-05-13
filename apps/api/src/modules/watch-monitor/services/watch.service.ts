// Stub — Agent A will replace this file with the full implementation.
// This file exists only to satisfy module resolution during testing.
import { Injectable } from '@nestjs/common';

@Injectable()
export class WatchService {
  transitionStopped(_id: string, _score: number, _reason: string): Promise<void> { return Promise.resolve(); }
}
