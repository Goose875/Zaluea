import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('keel', {
  status: () => ipcRenderer.invoke('status'),
  catalog: () => ipcRenderer.invoke('catalog'),
  saveCreds: (broker: string, creds: Record<string, string>) => ipcRenderer.invoke('creds:save', broker, creds),
  removeCreds: (broker: string) => ipcRenderer.invoke('creds:remove', broker),
  addAccount: (x: unknown) => ipcRenderer.invoke('accounts:add', x),
  updateAccounts: (ids: string[], patch: unknown) => ipcRenderer.invoke('accounts:update', ids, patch),
  removeAccount: (id: string) => ipcRenderer.invoke('accounts:remove', id),
  selectAccount: (id: string) => ipcRenderer.invoke('accounts:select', id),
  addSampleAccounts: () => ipcRenderer.invoke('accounts:samples'),
  setRisk: (risk: unknown) => ipcRenderer.invoke('risk:set', risk),
  start: () => ipcRenderer.invoke('engine:start'),
  stop: () => ipcRenderer.invoke('engine:stop'),
  copyAlert: () => ipcRenderer.invoke('copy:alert'),
  addStrategy: (cfg: unknown, source: string) => ipcRenderer.invoke('strategies:add', cfg, source),
  updateStrategy: (id: string, patch: unknown) => ipcRenderer.invoke('strategies:update', id, patch),
  removeStrategy: (id: string) => ipcRenderer.invoke('strategies:remove', id),
  checkPine: (text: string) => ipcRenderer.invoke('strategies:checkPine', text),
  copyStrategyAlert: (id: string) => ipcRenderer.invoke('copy:strategyAlert', id),
  chart: (symbol: string, tf: number) => ipcRenderer.invoke('chart:get', symbol, tf),
  backtest: (id: string, csv: string, opts: unknown) => ipcRenderer.invoke('backtest:run', id, csv, opts),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  kill: () => ipcRenderer.invoke('engine:kill')
});
