import { Sandbox } from 'e2b';

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
    if (process.env.SMOKE_INSTALL_SUPERCHARGE === '1') {
      const install = await sandbox.commands.run(
        `curl -fsSL https://www.superchargeai.in/install.sh -o /tmp/supercharge-install.sh && SUPERCHARGE_VERSION=1.3.30 SUPERCHARGE_GITHUB_REPO=iotserver24/supercharge-releases SUPERCHARGE_NO_MODIFY_PATH=1 bash /tmp/supercharge-install.sh && "$HOME/.local/bin/supercharge" --version && "$HOME/.local/bin/supercharge" --help | grep -E -- '--prompt-file|--always-approve|--max-turns|--output-format|--no-subagents|--disable-web-search'`,
        { timeoutMs: 90_000 },
      );
      console.log(install.stdout.trim());
    }
  } finally {
    await sandbox.kill();
  }
}
