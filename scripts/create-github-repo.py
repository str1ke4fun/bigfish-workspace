"""Create the authorized public repository using Git Credential Manager.

Never print credentials. This script does not upload local files.
"""
import json
import os
import subprocess
import urllib.error
import urllib.request

env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never')
credential = subprocess.run(['git', 'credential', 'fill'],
    input='protocol=https\nhost=github.com\n\n', text=True,
    capture_output=True, env=env, timeout=30)
fields = dict(line.split('=', 1) for line in credential.stdout.splitlines() if '=' in line)
token = fields.get('password')
if not token:
    raise SystemExit('No existing GitHub credential available; sign in before repository creation.')
request = urllib.request.Request('https://api.github.com/user/repos',
    data=json.dumps({'name': 'bigfish-workspace', 'private': False,
                     'description': 'Bigfish agent workspace: plugins, diagnostics and deployment scripts.'}).encode(),
    headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
             'User-Agent': 'bigfish-workspace-setup', 'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    print(json.dumps({'html_url': result['html_url'], 'clone_url': result['clone_url']}))
except urllib.error.HTTPError as error:
    raise SystemExit('GitHub repository creation returned HTTP ' + str(error.code))
except urllib.error.URLError:
    raise SystemExit('GitHub API is unreachable from this environment.')
