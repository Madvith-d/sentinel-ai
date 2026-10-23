import { Sandbox } from 'e2b';
import { superchargeConfig } from './prompt.js';

if (!process.env.E2B_API_KEY) {
  console.error('E2B_API_KEY is required');
  process.exitCode = 1;
} else {
  const sandbox = await Sandbox.create({ timeoutMs: 120_000, metadata: { purpose: 'nexathon-remediator-smoke' } });
  try {
    const result = await sandbox.commands.run('uname -m; git --version; curl --version | head -1; echo HOME=$HOME; command -v bun || true; command -v unzip || true', { timeoutMs: 30_000 });
    console.log(result.stdout.trim());
    if (process.env.SMOKE_INSTALL_BUN === '1') {
      const bun = await sandbox.commands.run(
        'curl -fsSL https://bun.com/install -o /tmp/bun-install.sh && bash /tmp/bun-install.sh bun-v1.3.11 && "$HOME/.bun/bin/bun" --version',
        { timeoutMs: 90_000 },
      );
      console.log(`sandbox Bun: ${bun.stdout.trim().split('\n').at(-1)}`);
    }
    if (process.env.SMOKE_CLONE_SHA) {
      if (!/^[0-9a-f]{40}$/i.test(process.env.SMOKE_CLONE_SHA)) throw new Error('SMOKE_CLONE_SHA must be a full commit SHA');
      const clone = await sandbox.commands.run(
        `git clone --no-checkout --filter=blob:none https://github.com/iotserver24/nexathon.git /home/user/nexathon && git -C /home/user/nexathon checkout --detach ${process.env.SMOKE_CLONE_SHA}`,
        { timeoutMs: 90_000 },
      );
      console.log(`cloned repo: ${clone.exitCode === 0 ? 'ok' : 'failed'}`);
      if (process.env.SMOKE_INSTALL_BUN === '1') {
        const check = await sandbox.commands.run(
          'export PATH="$HOME/.bun/bin:$PATH"; bun install --frozen-lockfile && bun run --cwd packages/remediator typecheck && bun test --cwd packages/remediator',
          { cwd: '/home/user/nexathon', timeoutMs: 180_000 },
        );
        console.log(`${check.stdout}\n${check.stderr}`.trim().split('\n').slice(-12).join('\n'));
      }
    }
    if (process.env.SMOKE_INSTALL_SUPERCHARGE === '1') {
      const install = await sandbox.commands.run(
        `curl -fsSL https://www.superchargeai.in/install.sh -o /tmp/supercharge-install.sh && SUPERCHARGE_VERSION=1.3.30 SUPERCHARGE_GITHUB_REPO=iotserver24/supercharge-releases SUPERCHARGE_NO_MODIFY_PATH=1 bash /tmp/supercharge-install.sh && "$HOME/.local/bin/supercharge" --version && "$HOME/.local/bin/supercharge" --help | grep -E -- '--prompt-file|--always-approve|--max-turns|--output-format|--no-subagents|--disable-web-search'`,
        { timeoutMs: 90_000 },
      );
      console.log(install.stdout.trim());
      if (process.env.SMOKE_MCP_CONFIG === '1') {
        await sandbox.files.write('/home/user/.supercharge/config.toml', superchargeConfig({
          modelName: 'smoke', modelId: 'dummy', baseUrl: 'https://example.invalid/v1',
          apiBackend: 'responses', apiKey: 'dummy-key', githubReadToken: 'dummy-read-token',
        }));
        const mcp = await sandbox.commands.run('"$HOME/.local/bin/supercharge" mcp list --json', {
          envs: { GITHUB_READ_TOKEN: 'dummy-read-token' }, timeoutMs: 30_000,
        });
        console.log(`Supercharge MCP config parsed: ${mcp.stdout.includes('github')}`);
      }
    }
  } finally {
    await sandbox.kill();
  }
}
