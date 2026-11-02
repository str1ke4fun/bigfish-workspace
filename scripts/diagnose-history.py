"""Read recovered frames without changing evidence or exposing message text."""
import argparse
from collections import Counter
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def diagnose(path):
    rows = []
    malformed = 0
    with path.open(encoding='utf-8-sig') as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                malformed += 1
    rows.sort(key=lambda row: row.get('seq', 10**18))
    active = None
    turns = []
    overlaps = []
    calls = Counter()
    targets = Counter()
    for row in rows:
        kind, seq = row.get('type'), row.get('seq')
        data = row.get('data') or {}
        if kind == 'turn/start':
            active = seq
        elif kind == 'turn/end' and active is not None:
            turns.append({'start': active, 'end': seq})
            active = None
        elif kind == 'agent/inbox/spliced':
            targets[str(data.get('target'))] += 1
            if active is not None:
                overlaps.append({'seq': seq, 'turn_start': active,
                                 'target': data.get('target'),
                                 'inserted_count': len(data.get('inserted') or [])})
        elif kind == 'tool/call':
            calls[str(data.get('name'))] += 1
    return {'frames': len(rows), 'malformed_lines': malformed,
            'completed_turns': len(turns), 'unfinished_turn_start': active,
            'spliced_targets': dict(targets), 'mid_turn_splices': overlaps,
            'tool_calls': dict(calls),
            'interpretation': 'Mid-turn arrival is evidence of concurrency, not proof of an incorrect reply. Verify trigger and reply message IDs at runtime.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('frames', nargs='?', type=Path,
                        default=ROOT / 'payload/recovered/session_frames.ndjson')
    parser.add_argument('--output', type=Path, default=ROOT / 'reports/history-diagnosis.json')
    args = parser.parse_args()
    result = diagnose(args.frames)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in result.items() if key != 'mid_turn_splices'}, ensure_ascii=True))
    print('mid_turn_splices:', len(result['mid_turn_splices']))
