import { CommandExitError, Sandbox, type CommandResult } from 'e2b';
import { remediationPrompt, superchargeConfig } from './prompt.js';
import type { ProviderConfig, RemediationFailure, RemediationRequest, RemediationResult } from './types.js';
import { shellQuote, truncate, validateChangedFiles, validateProvider, validateRequest } from './validation.js';

const REPO_DIR = '/home/user/nexathon';
const SC_VERSION = '1.3.30'; // Latest verified published release at initial implementation.
const BUN_VERSION = '1.3.11'; // Team's pinned Bun runtime; update together.
const MAX_PATCH_BYTES = 256 * 1024;

function redacted(text: string, config: ProviderConfig): string {
  let output = text;
  for (const secret of [config.apiKey, config.githubReadToken]) {
    if (secret && secret.length >= 4) output = output.replaceAll(secret, '[REDACTED]');
  }
  return truncate(output);
}

function failure(request: RemediationRequest, reason: RemediationFailure, message: string, evidence?: string): RemediationResult {
  return { ok: false, incidentId: request.incidentId, reason, message, ...(evidence ? { evidence } : {}) };
}

async function command(sandbox: Sandbox, cmd: string, timeoutMs: number, cwd?: string, envs?: Record<string, string>): Promise<CommandResult> {
  try {
    return await sandbox.commands.run(cmd, { cwd, envs, timeoutMs });
  } catch (error) {
    if (error instanceof CommandExitError) return { exitCode: error.exitCode, error: error.error, stdout: error.stdout, stderr: error.stderr };
    throw error;
  }
}

async function checked(sandbox: Sandbox, cmd: string, timeoutMs: number, cwd?: string): Promise<CommandResult> {
  const result = await command(sandbox, cmd, timeoutMs, cwd);
  if (result.exitCode !== 0) throw new Error(`Sandbox setup command failed (${result.exitCode}): ${truncate(result.stderr || result.stdout, 1500)}`);
  return result;
}

/**
 * Clone at an exact revision, reproduce the failure, run a bounded coding agent,
 * verify tests/build, and return a data-only patch. No GitHub write token enters E2B.
 */
export async function generateFixInE2B(request: RemediationRequest, provider: ProviderConfig): Promise<RemediationResult> {
  validateRequest(request);
  validateProvider(provider);
  if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required on the controller');
  const template = process.env.E2B_REMEDIATOR_TEMPLATE;
  if (!template) throw new Error('E2B_REMEDIATOR_TEMPLATE is required; the default base sandbox cannot install/build the sample app');

  let sandbox: Sandbox | undefined;
  try {
    const options = {
      timeoutMs: 600_000,
      metadata: { purpose: 'nexathon-remediation', incident: request.incidentId },
    };
    sandbox = await Sandbox.create(template, options);
    await checked(sandbox, `git clone --no-checkout --filter=blob:none ${shellQuote(`https://github.com/${request.repository}.git`)} ${REPO_DIR}`, 90_000);
    await checked(sandbox, `git checkout --detach ${shellQuote(request.commitSha)}`, 60_000, REPO_DIR);
    const head = (await checked(sandbox, 'git rev-parse HEAD', 10_000, REPO_DIR)).stdout.trim();
    if (head.toLowerCase() !== request.commitSha.toLowerCase()) throw new Error('Cloned revision does not match incident SHA');

    // Bun is used for dependency setup, tests, and build in the target repo.
    await checked(sandbox, `if [ -x "$HOME/.bun/bin/bun" ] && [ "$("$HOME/.bun/bin/bun" --version)" = "${BUN_VERSION}" ]; then "$HOME/.bun/bin/bun" --version; else curl -fsSL https://bun.com/install -o /tmp/bun-install.sh && bash /tmp/bun-install.sh bun-v${BUN_VERSION}; fi`, 90_000);
    const setup = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.setupCommand}`, 180_000, REPO_DIR);
    if (setup.exitCode !== 0) return failure(request, 'setup_failed', 'Project dependency setup failed', redacted(setup.stderr || setup.stdout, provider));

    if (request.reproductionFixture) {
      const destination = `${REPO_DIR}/${request.reproductionFixture.path}`;
      const existing = await command(sandbox, `test -e ${shellQuote(destination)}`, 10_000);
      if (existing.exitCode === 0) return failure(request, 'unsafe_patch', 'Fixture path already exists at the incident SHA');
      await sandbox.files.write(destination, request.reproductionFixture.content);
    }
    const baseline = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.reproduceCommand}`, 120_000, REPO_DIR);
    if (baseline.exitCode === 0) return failure(request, 'not_reproducible', 'Reproduction already passes at the incident SHA; no patch or PR created');

    await checked(sandbox,
      `if "$HOME/.local/bin/supercharge" --version 2>/dev/null | grep -q '^supercharge ${SC_VERSION} '; then "$HOME/.local/bin/supercharge" --version; else curl -fsSL https://www.superchargeai.in/install.sh -o /tmp/supercharge-install.sh && SUPERCHARGE_VERSION=${SC_VERSION} SUPERCHARGE_GITHUB_REPO=iotserver24/supercharge-releases SUPERCHARGE_NO_MODIFY_PATH=1 bash /tmp/supercharge-install.sh && "$HOME/.local/bin/supercharge" --version; fi`,
      90_000);
    await sandbox.files.write('/home/user/.supercharge/config.toml', superchargeConfig(provider));
    await checked(sandbox, 'chmod 700 /home/user/.supercharge && chmod 600 /home/user/.supercharge/config.toml', 10_000);
    await sandbox.files.write('/home/user/incident-prompt.txt', remediationPrompt(request));
    const envs = { GITHUB_READ_TOKEN: provider.githubReadToken };
    const agent = await command(sandbox,
      'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; supercharge --cwd /home/user/nexathon --prompt-file /home/user/incident-prompt.txt --always-approve --no-subagents --disable-web-search --max-turns 18 --output-format json',
      270_000, REPO_DIR, envs);
    if (agent.exitCode !== 0) return failure(request, 'agent_failed', 'Supercharge failed before a verified patch was available', redacted(agent.stderr || agent.stdout, provider));
    if (request.reproductionFixture) {
      const current = await sandbox.files.read(`${REPO_DIR}/${request.reproductionFixture.path}`);
      if (current !== request.reproductionFixture.content) return failure(request, 'unsafe_patch', 'Agent modified the trusted regression test');
    }

    const changed = await checked(sandbox,
      'git diff --name-only -z HEAD; git ls-files --others --exclude-standard -z', 15_000, REPO_DIR);
    const changedFiles = [...new Set(changed.stdout.split('\0').filter(Boolean))];
    try {
      validateChangedFiles(changedFiles);
    } catch (error) {
      return failure(request, changedFiles.length ? 'unsafe_patch' : 'no_patch', (error as Error).message);
    }

    const repro = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.reproduceCommand}`, 120_000, REPO_DIR);
    if (repro.exitCode !== 0) return failure(request, 'test_failed', 'Reproduction still fails after the patch', redacted(repro.stderr || repro.stdout, provider));
    const tests = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.testCommand}`, 120_000, REPO_DIR);
    if (tests.exitCode !== 0) return failure(request, 'test_failed', 'Project tests failed after the patch', redacted(tests.stderr || tests.stdout, provider));
    const build = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.buildCommand}`, 120_000, REPO_DIR);
    if (build.exitCode !== 0) return failure(request, 'build_failed', 'Project build failed after the patch', redacted(build.stderr || build.stdout, provider));

    // Stage only the demo target. Never return provider config, tokens, or edits elsewhere.
    await checked(sandbox, 'git add -A -- apps/sample', 15_000, REPO_DIR);
    const staged = await checked(sandbox, 'git diff --cached --name-only -z', 15_000, REPO_DIR);
    validateChangedFiles(staged.stdout.split('\0').filter(Boolean));
    const diff = await checked(sandbox, 'git diff --cached --binary --no-ext-diff HEAD', 20_000, REPO_DIR);
    if (!diff.stdout || Buffer.byteLength(diff.stdout) > MAX_PATCH_BYTES) return failure(request, 'unsafe_patch', 'Patch is empty or exceeds 256 KiB');
    if (diff.stdout.includes(provider.apiKey) || (provider.githubReadToken && diff.stdout.includes(provider.githubReadToken))) {
      return failure(request, 'unsafe_patch', 'Patch contains a controller-provided secret');
    }
    if (/^(?:new file mode|deleted file mode) 120000$/m.test(diff.stdout) || diff.stdout.includes('GIT binary patch')) {
      return failure(request, 'unsafe_patch', 'Symlinks and binary patches require human review');
    }
    return {
      ok: true,
      incidentId: request.incidentId,
      baseSha: head,
      patch: diff.stdout,
      changedFiles,
      baseline: redacted(baseline.stderr || baseline.stdout, provider),
      agentSummary: redacted(agent.stdout || agent.stderr, provider),
      testOutput: redacted(`${repro.stdout}\n${tests.stdout}\n${tests.stderr}`, provider),
      buildOutput: redacted(`${build.stdout}\n${build.stderr}`, provider),
      mcpConfigured: Boolean(provider.githubReadToken),
    };
  } catch (error) {
    // Never surface command arguments or config files in error text.
    return failure(request, 'sandbox_error', 'Sandbox setup, execution, or verification failed', redacted(String(error), provider));
  } finally {
    if (sandbox) await sandbox.kill().catch(() => undefined);
  }
}
