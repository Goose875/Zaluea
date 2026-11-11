/** What the app can connect to, and which prop firms use what. Shared by the UI and the main process. */
export type Status = 'ready' | 'beta' | 'needs-approval';
export interface Field { key: string; label: string; secret: boolean; optional?: boolean }
export interface BrokerDef { id: string; name: string; status: Status; note: string; fields: Field[]; dev?: boolean }
export interface FirmDef { name: string; via: string[]; rules: string }

export const BROKERS: BrokerDef[] = [
  { id: 'paper', name: 'Paper trading', status: 'ready', note: 'Practice with pretend money. No keys needed.', fields: [] },
  { id: 'topstep-test', name: 'Pretend account (dev)', status: 'ready', dev: true, note: 'A pretend prop account with past days and moving prices, for testing rules and progress. Only in the dev version. No real money.', fields: [] },
  { id: 'projectx', name: 'TopstepX (ProjectX)', status: 'beta', note: 'For your Topstep accounts. Needs a ProjectX API subscription and key from Topstep. Try it on a practice account first.',
    fields: [{ key: 'userName', label: 'TopstepX username', secret: false }, { key: 'apiKey', label: 'API key', secret: true }] },
  { id: 'rithmic', name: 'Rithmic', status: 'beta', note: "For your Lucid accounts. Rithmic has approved Keel for its live systems. Pick the Chicago server and your firm's system (Lucid: LucidTrading), then enter the Rithmic username and password your firm gave you. Your firm must allow Rithmic API logins on your account. To practise with fake prices, pick the Rithmic Test server.",
    fields: [{ key: 'gateway', label: 'Server', secret: false, optional: true }, { key: 'system', label: "System (your firm's)", secret: false, optional: true },
      { key: 'user', label: 'Rithmic username', secret: false }, { key: 'password', label: 'Rithmic password', secret: true }] }
];

// From public reports in 2026. Platforms and bot rules change often, so always confirm with the firm.
// "tradovate" and "ninjatrader" are listed so you can see what each firm offers; Keel connections for them are not built yet.
export const FIRMS: FirmDef[] = [
  { name: 'Topstep', via: ['projectx'], rules: 'Automation goes through the TopstepX API. Check their rules on unattended bots.' },
  { name: 'Lucid Trading', via: ['rithmic'], rules: 'Your Lucid accounts use Rithmic. Check their automation rules before trading live.' }
];
