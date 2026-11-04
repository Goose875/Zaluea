/** What the app can connect to, and which prop firms use what. Shared by the UI and the main process. */
export type Status = 'ready' | 'beta' | 'needs-approval';
export interface Field { key: string; label: string; secret: boolean }
export interface BrokerDef { id: string; name: string; status: Status; note: string; fields: Field[]; dev?: boolean }
export interface FirmDef { name: string; via: string[]; rules: string }

export const BROKERS: BrokerDef[] = [
  { id: 'paper', name: 'Paper trading', status: 'ready', note: 'Practice with pretend money. No keys needed.', fields: [] },
  { id: 'topstep-test', name: 'Pretend account (dev)', status: 'ready', dev: true, note: 'A pretend prop account with past days and moving prices, for testing rules and progress. Only in the dev version. No real money.', fields: [] },
  { id: 'projectx', name: 'TopstepX (ProjectX)', status: 'beta', note: 'For your Topstep accounts. Needs a ProjectX API subscription and key from Topstep. Try it on a practice account first.',
    fields: [{ key: 'userName', label: 'TopstepX username', secret: false }, { key: 'apiKey', label: 'API key', secret: true }] },
  { id: 'rithmic', name: 'Rithmic', status: 'beta', note: "For your Lucid accounts (R | Protocol API). Leave System and Gateway empty to use Rithmic's test system (Rithmic Test). Trading Lucid accounts with live data needs Rithmic's conformance approval first; then use the system and gateway Rithmic/Lucid give you.",
    fields: [{ key: 'user', label: 'Rithmic username (your sign-up email)', secret: false }, { key: 'password', label: 'Rithmic password', secret: true },
      { key: 'system', label: 'System name (empty = Rithmic Test)', secret: false }, { key: 'gateway', label: 'Gateway (empty = wss://rituz00100.rithmic.com:443)', secret: false }] }
];

// From public reports in 2026. Platforms and bot rules change often, so always confirm with the firm.
// "tradovate" and "ninjatrader" are listed so you can see what each firm offers; Keel connections for them are not built yet.
export const FIRMS: FirmDef[] = [
  { name: 'Topstep', via: ['projectx'], rules: 'Automation goes through the TopstepX API. Check their rules on unattended bots.' },
  { name: 'Lucid Trading', via: ['rithmic'], rules: 'Your Lucid accounts use Rithmic. Check their automation rules before trading live.' }
];
