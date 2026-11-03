import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_RISK, parseRisk, RiskLimits } from '../core/risk';
import { DEFAULT_GOALS, Goals, parseGoals } from '../core/goals';

const file = () => path.join(app.getPath('userData'), 'risk.json');

export function loadRisk(): RiskLimits {
  try { return parseRisk(JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch { return DEFAULT_RISK; }
}
export function saveRisk(r: RiskLimits) { fs.writeFileSync(file(), JSON.stringify(r)); }

const goalsFile = () => path.join(app.getPath('userData'), 'goals.json');
export function loadGoals(): Goals {
  try { return parseGoals(JSON.parse(fs.readFileSync(goalsFile(), 'utf8'))); } catch { return DEFAULT_GOALS; }
}
export function saveGoals(g: Goals) { fs.writeFileSync(goalsFile(), JSON.stringify(g)); }
