import { BrokerAdapter } from '../core/types';
import { PaperBroker } from './paper';
import { ProjectXBroker } from './projectx';
import { RithmicBroker } from './rithmic';
import { TopstepTestBroker } from './topstepTest';
import type { AccountRecord } from '../core/accounts';

export const ADAPTERS: Record<string, (acct?: AccountRecord) => BrokerAdapter> = {
  paper: () => new PaperBroker(),
  'topstep-test': acct => new TopstepTestBroker(Math.random, acct),
  projectx: acct => new ProjectXBroker(undefined, undefined, acct),
  rithmic: acct => new RithmicBroker(acct),
};
