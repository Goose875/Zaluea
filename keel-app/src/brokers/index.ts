import { BrokerAdapter } from '../core/types';
import { PaperBroker } from './paper';
import { ProjectXBroker } from './projectx';
import { GatedBroker } from './gated';
import { TopstepTestBroker } from './topstepTest';
import type { AccountRecord } from '../core/accounts';

export const ADAPTERS: Record<string, (acct?: AccountRecord) => BrokerAdapter> = {
  paper: () => new PaperBroker(),
  'topstep-test': acct => new TopstepTestBroker(Math.random, acct),
  projectx: acct => new ProjectXBroker(undefined, undefined, acct),
  rithmic: () => new GatedBroker('rithmic', 'Rithmic',
    'Lucid via Rithmic is not live yet. Rithmic has to approve Keel for API access first. Your login is saved for when it is.'),
};
