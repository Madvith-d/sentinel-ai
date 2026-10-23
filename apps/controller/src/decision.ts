export type ProbeResult = 'pass' | 'fail' | 'unknown';

export interface IncidentAssessment {
  kind: 'runtime_regression' | 'persistent_defect' | 'build_failure';
  projectId: string;
  allowlistedProjectIds: ReadonlySet<string>;
  currentDeploymentIsProduction: boolean;
  currentDeploymentIsRecent: boolean;
  consecutiveCurrentFailures: number;
  probePath: string;
  currentProbe: ProbeResult;
  previousDeploymentId?: string;
  previousProbePath?: string;
  previousProbe?: ProbeResult;
  evidenceConsistent: boolean;
  rollbackAlreadyAttempted: boolean;
}

export type IncidentAction = 'monitor' | 'rollback' | 'fix_pr' | 'escalate';

export interface IncidentDecision {
  action: IncidentAction;
  reason: string;
}

export function decideIncident(assessment: IncidentAssessment): IncidentDecision {
  if (assessment.kind === 'build_failure') {
    return {
      action: 'fix_pr',
      reason: 'Build failures do not change or roll back the active production deployment.',
    };
  }

  if (assessment.consecutiveCurrentFailures < 3) {
    return {
      action: 'monitor',
      reason: 'Require three consecutive failures of the same probe before acting.',
    };
  }

  if (!assessment.evidenceConsistent || assessment.currentProbe !== 'fail') {
    return {
      action: 'escalate',
      reason: 'Probe evidence is conflicting or does not confirm a current-deployment failure.',
    };
  }

  if (!assessment.allowlistedProjectIds.has(assessment.projectId)) {
    return {
      action: 'escalate',
      reason: 'The project is not on the controller rollback allowlist.',
    };
  }

  if (!assessment.currentDeploymentIsProduction) {
    return {
      action: 'escalate',
      reason: 'The affected deployment is not confirmed as the current production deployment.',
    };
  }

  if (!assessment.currentDeploymentIsRecent) {
    return {
      action: 'escalate',
      reason: 'The deployment is outside the configured incident recency window.',
    };
  }

  if (!assessment.probePath || assessment.previousProbePath !== assessment.probePath) {
    return {
      action: 'escalate',
      reason: 'The current and predecessor must be probed on the same confirmed route.',
    };
  }

  if (!assessment.previousDeploymentId || !assessment.previousProbe || assessment.previousProbe === 'unknown') {
    return {
      action: 'escalate',
      reason: 'A trustworthy predecessor and its same-route probe result are required.',
    };
  }

  if (assessment.previousProbe === 'pass') {
    if (assessment.rollbackAlreadyAttempted) {
      return {
        action: 'escalate',
        reason: 'A rollback was already attempted for this deployment; no retry is allowed.',
      };
    }

    return {
      action: 'rollback',
      reason: 'The current production deployment fails while its predecessor passes.',
    };
  }

  return {
    action: 'fix_pr',
    reason: 'The current and previous deployments fail; rollback is unlikely to resolve the defect.',
  };
}
