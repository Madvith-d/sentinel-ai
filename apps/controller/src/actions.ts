import { readFile } from 'node:fs/promises';
import { generateFixInE2B, publishDraftPr, type ProviderConfig, type RemediationRequest } from '@nexathon/remediator';
import { notifyIncident, redact, type Incident } from '@nexathon/notifier';
import type { MonitorActions, RemediationOutcome } from './monitor';

export interface RemediationConfig {
  repository: string;
  setupCommand: string;
  reproduceCommand: string;
  testCommand: string;
  buildCommand: string;
  provider: ProviderConfig;
  reproductionFixture?: { path: string; sourceFile: string };
}

export interface ControllerActionsConfig {
  slackWebhookUrl?: string;
  remediation?: RemediationConfig;
}

async function runRemediation(incident: Incident, config: RemediationConfig): Promise<RemediationOutcome> {
  if (!incident.commitSha) return { ok: false, message: 'Incident has no commit SHA; remediation was not started.' };

  let reproductionFixture: RemediationRequest['reproductionFixture'];
  if (config.reproductionFixture) {
    try {
      reproductionFixture = {
        path: config.reproductionFixture.path,
        content: await readFile(config.reproductionFixture.sourceFile, 'utf8'),
      };
    } catch {
      return { ok: false, message: 'Trusted remediation fixture could not be read; no PR was created.' };
    }
  }

  const request: RemediationRequest = {
    incidentId: incident.id,
    repository: config.repository,
    commitSha: incident.commitSha,
    evidence: incident.evidence,
    setupCommand: config.setupCommand,
    reproduceCommand: config.reproduceCommand,
    testCommand: config.testCommand,
    buildCommand: config.buildCommand,
    ...(reproductionFixture ? { reproductionFixture } : {}),
  };

  try {
    const fix = await generateFixInE2B(request, config.provider);
    if (!fix.ok) {
      return {
        ok: false,
        message: `Remediation stopped safely: ${fix.message}`,
        ...(fix.evidence ? { evidence: [redact(fix.evidence)] } : {}),
      };
    }
    const draftPr = await publishDraftPr(request, fix);
    return {
      ok: true,
      actionUrl: draftPr.url,
      message: 'Verified patch published as a draft PR for human review.',
      evidence: ['Reproduction failed before patching; targeted tests and build passed afterward.'],
    };
  } catch (error) {
    return { ok: false, message: 'Remediation failed safely; no PR was created.', evidence: [redact(String(error))] };
  }
}

export function createControllerActions(config: ControllerActionsConfig): MonitorActions {
  return {
    notify: async incident => {
      const result = await notifyIncident(incident, { webhookUrl: config.slackWebhookUrl });
      return result.ok ? { ok: true, message: 'Slack notification sent.' } : { ok: false, message: result.message };
    },
    ...(config.remediation ? { remediate: incident => runRemediation(incident, config.remediation!) } : {}),
  };
}
