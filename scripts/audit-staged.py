"""Report potential secrets in Git's index without printing matched values."""
import json
import re
import subprocess

patterns = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})'),
    'api-key': re.compile(r'\bsk-[A-Za-z0-9_-]{24,}'),
    'cookie-value': re.compile(r'(?i)\b(?:SESSDATA|bili_jct)\s*[=:]\s*[\"\x27]?([A-Za-z0-9%_-]{20,})'),
}
paths = subprocess.check_output(['git', 'diff', '--cached', '--name-only', '-z']).decode().split('\0')
findings = []
large = []
for path in filter(None, paths):
    blob = subprocess.check_output(['git', 'show', ':' + path])
    if len(blob) > 5 * 1024 * 1024:
        large.append(path)
    for line_number, line in enumerate(blob.decode('utf-8', errors='replace').splitlines(), 1):
        for kind, pattern in patterns.items():
            if pattern.search(line):
                # Exact, reviewed synthetic credential used to test the guard.
                if (path == 'src/dsh-fish/test/guard.test.mjs'
                        and line.strip() == "'sk-" + 'abcdefghijklmnopqrstuvwx' + "',"
                        and kind == 'api-key'):
                    continue
                findings.append({'path': path, 'line': line_number, 'kind': kind})
print(json.dumps({'candidate_secrets': findings, 'large_files': large}, indent=2))
raise SystemExit(bool(findings or large))
