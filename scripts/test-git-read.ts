// Фильтр Bash шага процесса с `shell: "git-read"` (T-570): одна git-команда
// на чтение — можно, всё остальное — нет. npm run test:gitread
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { readFileSync } from 'node:fs';
import { gitReadOnlyProblem } from '../src/server/permissions';
import { parseWorkflow } from '../src/shared/workflow';

const allowed = [
  'git log --oneline -20',
  'git log --format="%h %an %s" main..HEAD',
  "git log --format='%h %s' -- src/server/agents.ts",
  'git diff main...HEAD --stat',
  'git diff HEAD~1 -- docs/',
  'git show 6329767',
  'git show HEAD:src/server/review.ts',
  'git status',
  'git status --porcelain',
  'git blame -L 10,40 src/server/permissions.ts',
  'git rev-parse HEAD',
  'git rev-parse --abbrev-ref HEAD',
  'git ls-files src/server',
  'git ls-tree -r HEAD --name-only',
  'git cat-file -p HEAD',
  'git branch',
  'git branch -a -v',
  'git branch --list "task/*"',
  'git branch --contains 6329767',
  'git shortlog -sn',
  'git describe --tags',
  'git merge-base main HEAD',
  'git rev-list --count HEAD',
  'git grep -n gitReadOnlyProblem',
  'git reflog',
  'git reflog show HEAD',
  'git remote -v',
  'git worktree list',
  'git --no-pager log -5',
  '  git log -1  ',
];

const denied = [
  // пишущие git-команды
  'git commit -m x',
  'git commit --amend --no-edit',
  'git push origin main',
  'git reset --hard HEAD~1',
  'git checkout main',
  'git switch main',
  'git restore src/a.ts',
  'git merge main',
  'git rebase main',
  'git stash',
  'git stash list',
  'git clean -fd',
  'git tag v1.0.0',
  'git config user.name x',
  'git add .',
  'git rm a.ts',
  'git mv a.ts b.ts',
  'git fetch',
  'git pull',
  'git cherry-pick abc',
  'git revert abc',
  'git apply x.patch',
  'git gc',
  'git update-ref refs/heads/main HEAD',
  'git branch new-branch',
  'git branch -D task/T-1',
  'git branch -m old new',
  'git branch --set-upstream-to=origin/main',
  'git branch -f main HEAD~1',
  'git reflog expire --all',
  'git reflog delete HEAD@{1}',
  'git remote add evil https://x',
  'git remote set-url origin https://x',
  'git worktree add ../x',
  'git worktree remove x',
  // читающие подкоманды с пишущими ключами
  'git diff --output=patch.txt',
  'git log --output patch.txt',
  'git grep -O foo',
  'git diff --ext-diff',
  // опасные глобальные ключи
  'git -c core.pager=sh log',
  'git -C /tmp log',
  'git --git-dir=/x log',
  'git --exec-path=/x log',
  // не git
  'ls -la',
  'cat src/a.ts',
  'rm -rf .',
  'npm test',
  'env git log',
  'command git log',
  '/usr/bin/git log',
  'GIT_DIR=/x git log',
  'git',
  '',
  // цепочки, подстановки, перенаправления
  'git log; rm -rf .',
  'git log && git push',
  'git log || true',
  'git log | head',
  'git log & sleep 1',
  'git show $(echo HEAD)',
  'git show `echo HEAD`',
  'git log --format=$HOME',
  'git log > out.txt',
  'git log >> out.txt',
  'git diff < x',
  'git log\ngit push',
  'git log \\; rm x',
  'git log "unterminated',
];

let failed = 0;
for (const cmd of allowed) {
  const problem = gitReadOnlyProblem(cmd);
  if (problem !== null) {
    failed++;
    console.error(`✗ должно пройти: ${JSON.stringify(cmd)} — отказ «${problem}»`);
  }
}
for (const cmd of denied) {
  if (gitReadOnlyProblem(cmd) === null) {
    failed++;
    console.error(`✗ должно быть отклонено: ${JSON.stringify(cmd)}`);
  }
}

// Встроенный процесс исследования: verify получает git на чтение, остальные
// шаги — без добавочной оболочки (права других шагов не меняются).
for (const file of ['research', 'feature', 'feature-qa', 'content', 'design']) {
  const wf = parseWorkflow(JSON.parse(readFileSync(`workflows/${file}.json`, 'utf8')), file);
  for (const node of wf.nodes) {
    const expect = file === 'research' && node.id === 'verify' ? 'git-read' : undefined;
    if (node.shell !== expect) {
      failed++;
      console.error(`✗ ${file}.${node.id}: shell=${node.shell}, ждали ${expect}`);
    }
  }
}

// Опечатка в значении — ошибка разбора, а не тихий полный Bash.
try {
  parseWorkflow({
    id: 'x', version: 1, trigger: { on: 'task.finished', type: 'code' },
    nodes: [{ id: 'a', kind: 'step', shell: 'bash', next: { done: 'end' } }],
  });
  failed++;
  console.error('✗ shell: "bash" должен отклоняться схемой');
} catch { /* так и надо */ }

const total = allowed.length + denied.length;
if (failed) {
  console.error(`\n${failed} ошибок`);
  process.exit(1);
}
console.log(`✓ git на чтение: ${allowed.length} разрешено, ${denied.length} отклонено (${total} команд); процессы в порядке`);
