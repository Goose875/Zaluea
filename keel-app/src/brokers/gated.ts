import { BrokerAdapter } from '../core/types';

/** For connections whose API access must be approved by the provider first. Saves keys, refuses to trade. */
export class GatedBroker implements BrokerAdapter {
  constructor(readonly id: string, readonly name: string, private why: string) {}
  async connect(): Promise<void> { throw new Error(this.why); }
  async disconnect() {}
  async placeOrder(): Promise<string> { throw new Error(this.why); }
  async closeAll() {}
  async getPositions() { return []; }
  async getDailyPnL() { return 0; }
  onQuote() {}
}
