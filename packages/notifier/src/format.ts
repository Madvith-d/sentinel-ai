// Ronit owns the shared package; this structural boundary mirrors README until it exports types.
export interface Incident {
  id: string;
  kind: 'runtime_regression' | 'persistent_defect' | 'build_failure';
  status: 'detected' | 'investigating' | 'rolling_back' | 'remediating' | 'recovered' | 'pr_opened' | 'needs_human';
  detectedAt: string;
  projectId: string;
  deploymentId?: string;
  deploymentUrl?: string;
  commitSha?: string;
  previousDeploymentUrl?: string;
  probePath?: string;
  evidence: string[];
  decision?: 'rollback' | 'fix_pr' | 'escalate';
  actionUrl?: string;
  events: Array<{ at: string; type: string; message: string }>;
}

export function redact(value: string, maxLength = 600): string {
  const clean = value
    .replace(/((?:["']?[\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w.-]*["']?)\s*[:=]\s*)(?!(?:Bearer|Basic)\s)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi, '$1[REDACTED]')
    .replace(/https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[^\s<>"']+/gi, '[REDACTED webhook]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[REDACTED authorization]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED token]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const limit = Math.max(1, Math.min(maxLength, 3000));
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function safeLink(value?: string): string | undefined {
  if (!value || value.length > 1000 || /[\s<>|]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    if (redact(value, 3000) !== value) return undefined;
    // Query strings and fragments can carry credentials; action links need neither.
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

export const statusLabels: Record<Incident['status'], string> = {
  detected: 'Detected', investigating: 'Investigating', rolling_back: 'Rolling back',
  remediating: 'Preparing fix', recovered: 'Recovered', pr_opened: 'Draft PR opened', needs_human: 'Needs human',
};
export const kindLabels: Record<Incident['kind'], string> = {
  runtime_regression: 'Fresh runtime regression', persistent_defect: 'Persistent defect', build_failure: 'Failed build',
};
export const decisionLabels: Record<NonNullable<Incident['decision']>, string> = {
  rollback: 'Rollback', fix_pr: 'Draft fix PR', escalate: 'Escalate to a human',
};
export const rollbackCaveat = 'After a Vercel rollback, automatic production-domain assignment can be disabled until a human promotes a repaired deployment.';

function escapeSlack(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('*', '＊').replaceAll('_', '＿').replaceAll('`', '′').replaceAll('~', '～');
}

export interface IncidentReport {
  text: string;
  blocks: Array<{ type: 'section'; text: { type: 'plain_text' | 'mrkdwn'; text: string; emoji?: boolean } }>;
}

export function formatIncidentReport(incident: Incident): IncidentReport {
  const lines = [
    `Nexathon · ${statusLabels[incident.status]}`,
    `Incident: ${redact(incident.id, 120)} · ${kindLabels[incident.kind]}`,
    `Project: ${redact(incident.projectId, 120)}`,
    `Detected: ${redact(incident.detectedAt, 80)}`,
    `Decision: ${incident.decision ? decisionLabels[incident.decision] : 'Not decided'}`,
  ];
  if (incident.deploymentId) lines.push(`Deployment: ${redact(incident.deploymentId, 120)}`);
  if (incident.commitSha) lines.push(`Revision: ${redact(incident.commitSha, 80)}`);
  if (incident.probePath) lines.push(`Probe: ${redact(incident.probePath, 160)}`);
  const evidence = incident.evidence.slice(0, 4).map(item => `• ${redact(item, 350)}`);
  lines.push('Evidence:', ...(evidence.length ? evidence : ['No evidence recorded.']));
  if (incident.evidence.length > 4) lines.push(`${incident.evidence.length - 4} more evidence entries in the incident.`);
  if (incident.events.length) lines.push(`Latest event: ${redact([...incident.events].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!.message, 350)}`);
  if (incident.status === 'pr_opened') lines.push('Draft PR only. Recovery is not verified; no code is merged automatically.');
  if (incident.status === 'rolling_back') lines.push('Rollback is in progress; recovery is not yet verified.');
  if (incident.status === 'needs_human') lines.push('Human review required. No further automatic action should be assumed.');
  if (incident.decision === 'rollback') lines.push(rollbackCaveat);
  const action = safeLink(incident.actionUrl);
  if (action) lines.push(`Action: ${action}`);
  const text = lines.join('\n');
  const blocks: IncidentReport['blocks'] = [
    { type: 'section', text: { type: 'plain_text', text: text.replace(/\nAction:.*$/, ''), emoji: false } },
  ];
  if (action) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${escapeSlack(action)}|${incident.decision === 'fix_pr' ? 'Review draft PR' : 'View action'}>` } });
  return { text, blocks };
}
